import {McpServer, type ServerContext} from '@modelcontextprotocol/server';
import {type ZodType} from 'zod';
import {type AnalyticsRecorderType} from '../../core/analytics/recorder.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {type LoggerType} from '../../core/logging/logger.ts';
import {type CodeIndex} from '../../core/generation/codeIndex.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../../core/version.ts';
import {errorEnvelope, successDataBudget, successEnvelope, toCallToolResult, type ToolEnvelopeType} from './toolResponses.ts';
import {compactOutlineOf, compactSymbolsOf} from './compactResults.ts';
import {
	FindDependenciesInputSchema,
	FindReferencesInputSchema,
	FindSymbolInputSchema,
	IndexStatusInputSchema,
	OutlineInputSchema,
	ReadSymbolInputSchema,
	SymbolAtInputSchema,
} from './toolSchemas.ts';

const debug = debugFor('mcp');

const SERVER_INSTRUCTIONS = `For code navigation in this workspace, use the code index before broad grep or whole-file reads.
Use find_symbol to locate a declaration by name, outline to inspect a known file, find_references to find consumers, find_dependencies to find external dependency usage, and read_symbol to read the smallest useful source range. Use symbol_at to resolve a source position to its innermost stored declaration.
outline and find_symbol return compact items by default; pass detail full only when qualified names, bindings, or definition sites are required.
For "where is dependency X used?" call find_dependencies once with transitive false and compact detail, using a package target identifier such as lodash. Direct usage covers external dependencies only; to find importers of an authored file, resolve a symbol it exports with find_symbol and call find_references. A current, untruncated direct result is the complete answer: report the returned paths and stop. Do not search manifests, grep source, read the listed files, or expand into downstream consumers unless the question asks for those facts.
Use detail evidence only when import statements, bindings, or locations are requested. Request transitive true only when the question asks about downstream dependency impact; those results prove authored-module reachability, not binding use. Filter with root to inspect one direct consumer.
Package manifests and lint or build configuration are outside the indexed workspace; use at most one targeted repository search when those facts are required.
Every result reports a generation, explicit freshness, and truncation. Treat current freshness as usable, updating as readable but possibly stale, and stale or unknown as a fallback trigger.
Paginated limits are upper bounds; follow nextCursor whenever truncated is true.
Fall back to normal repository tools when the index reports stale data, incomplete scope, an unknown symbol, or no match.
The index covers the sources selected by the configured extractor projects. Results list the project contexts that produced each fact; pass a context to find_symbol, find_references, or find_dependencies to restrict results. Unconfigured projects and other languages are outside its scope.`;

type ToolRegistrationType = Readonly<{
	name: string;
	description: string;
	maxResultBytes: number;
	logger: LoggerType;
	analytics: AnalyticsRecorderType | null;
	invoke: (args: unknown) => ToolEnvelopeType | Promise<ToolEnvelopeType>;
}>;

const sessionIdOf = (context: ServerContext): string | null => {
	const request: unknown = context.mcpReq;
	const meta = typeof request === 'object' && request !== null && '_meta' in request ? request['_meta'] : undefined;
	const sessionId = typeof meta === 'object' && meta !== null && 'ai.opencode/sessionID' in meta ? meta['ai.opencode/sessionID'] : undefined;

	return typeof sessionId === 'string' ? sessionId : (context.sessionId ?? null);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

const dataOf = (envelope: ToolEnvelopeType): Readonly<Record<string, unknown>> | null => (envelope.ok && isRecord(envelope.data) ? envelope.data : null);

const envelopeFreshness = (envelope: ToolEnvelopeType): string | null => {
	const data = dataOf(envelope);
	const freshness = data?.['freshness'];

	if (typeof freshness === 'string') {
		return freshness;
	}

	if (typeof freshness === 'object' && freshness !== null && 'state' in freshness) {
		const {state} = freshness as {state?: unknown};
		return typeof state === 'string' ? state : null;
	}

	return null;
};

const envelopeTruncated = (envelope: ToolEnvelopeType): boolean => dataOf(envelope)?.['truncated'] === true;

const register = (server: McpServer, registration: ToolRegistrationType, inputSchema: ZodType): void => {
	server.registerTool(
		registration.name,
		{
			title: registration.name,
			description: registration.description,
			inputSchema,
			annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
		},
		async (args: unknown, context: ServerContext) => {
			const startedAt = performance.now();
			let envelope: ToolEnvelopeType;
			debug('tool call start', {tool: registration.name, sessionId: sessionIdOf(context)});

			try {
				envelope = await registration.invoke(args);
			} catch (error) {
				debug('tool call threw', {tool: registration.name, message: error instanceof Error ? error.message : String(error)});
				envelope = errorEnvelope(error);
			}

			const durationMs = Math.round(performance.now() - startedAt);
			const response = toCallToolResult(envelope, registration.maxResultBytes);
			debug('tool call complete', {
				tool: registration.name,
				durationMs,
				bytes: response.bytes,
				items: response.itemCount,
				ok: envelope.ok,
				errorCode: envelope.ok ? null : envelope.error.code,
			});

			registration.logger.debug('tool call complete', {
				tool: registration.name,
				durationMs,
				bytes: response.bytes,
				items: response.itemCount,
				ok: envelope.ok,
				errorCode: envelope.ok ? null : envelope.error.code,
			});
			registration.analytics?.record('mcp_tool_call', {
				tool: registration.name,
				sessionId: sessionIdOf(context),
				durationMs,
				bytes: response.bytes,
				items: response.itemCount,
				ok: envelope.ok,
				errorCode: envelope.ok ? null : envelope.error.code,
				freshness: envelopeFreshness(envelope),
				truncated: envelopeTruncated(envelope),
			});

			return response.result;
		},
	);
};

/**
 * Builds the outline tool handler, projecting compact items unless full detail is requested.
 *
 * @param index - Index facade.
 * @param maxResultBytes - Response byte limit.
 * @returns Handler that validates input, queries, and envelopes the result.
 */
const outlineHandlerOf =
	(index: CodeIndex, maxResultBytes: number) =>
	(rawArgs: unknown): ToolEnvelopeType => {
		const {detail, ...query} = OutlineInputSchema.parse(rawArgs);
		const result = index.getOutline(query, successDataBudget(maxResultBytes));

		return successEnvelope(detail === 'full' ? result : compactOutlineOf(result));
	};

/**
 * Builds the symbol-search handler, projecting compact items unless full detail is requested.
 *
 * @param index - Index facade.
 * @param maxResultBytes - Response byte limit.
 * @returns Handler that validates input, queries, and envelopes the result.
 */
const findSymbolsHandlerOf =
	(index: CodeIndex, maxResultBytes: number) =>
	(rawArgs: unknown): ToolEnvelopeType => {
		const {detail, ...query} = FindSymbolInputSchema.parse(rawArgs);
		const result = index.findSymbols(query, successDataBudget(maxResultBytes));

		return successEnvelope(detail === 'full' ? result : compactSymbolsOf(result));
	};

/**
 * Builds the local stdio MCP server that exposes the seven read-only index tools.
 *
 * The adapter validates transport input, calls one `CodeIndex` method, and
 * translates the result. It deliberately contains no SQL or compiler behavior.
 *
 * @param input - Index facade, logger, and response byte limit.
 * @returns The configured MCP server.
 */
export const buildMcpServer = (
	input: Readonly<{
		index: CodeIndex;
		logger: LoggerType;
		analytics?: AnalyticsRecorderType;
		maxResultBytes: number;
	}>,
): McpServer => {
	const server = new McpServer({name: PROGRAM_NAME, version: PROGRAM_VERSION}, {instructions: SERVER_INSTRUCTIONS});
	const {index, logger, maxResultBytes, analytics = null} = input;
	debug('mcp server built', {name: PROGRAM_NAME, version: PROGRAM_VERSION, maxResultBytes});
	const tool = (registration: ToolRegistrationType, inputSchema: ZodType): void => {
		register(server, registration, inputSchema);
	};
	tool(
		{
			name: 'index_status',
			description: 'Report index readiness, scope, counts, freshness, diagnostics, and exclusions.',
			maxResultBytes,
			logger,
			analytics,
			invoke: () => successEnvelope(index.getStatus()),
		},
		IndexStatusInputSchema,
	);

	tool(
		{
			name: 'outline',
			description:
				'List declarations defined in one indexed file, in source order. Compact detail (default) returns symbolId, name, kind, and line range; full detail adds qualified names, bindings, and definition sites.',
			maxResultBytes,
			logger,
			analytics,
			invoke: outlineHandlerOf(index, maxResultBytes),
		},
		OutlineInputSchema,
	);

	tool(
		{
			name: 'find_symbol',
			description:
				'Find a declaration by exact qualified name, exact simple name, or name prefix. Compact detail (default) returns symbolId, name, qualified name, kind, and line range; full detail adds bindings, names, and definition sites.',
			maxResultBytes,
			logger,
			analytics,
			invoke: findSymbolsHandlerOf(index, maxResultBytes),
		},
		FindSymbolInputSchema,
	);

	tool(
		{
			name: 'find_references',
			description: 'Find definitions and references for one indexed symbol identifier.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.findReferences(FindReferencesInputSchema.parse(rawArgs), successDataBudget(maxResultBytes))),
		},
		FindReferencesInputSchema,
	);

	tool(
		{
			name: 'find_dependencies',
			description:
				'Find authored modules that consume a canonical external dependency target, such as lodash or @mui/material. Direct usage is external-only; find importers of an authored file by resolving an exported symbol with find_symbol and calling find_references. For direct usage, call once with transitive false and compact detail; a current untruncated result is the complete answer. Transitive mode returns dependency impact grouped by direct root. Pages may be shortened to the response byte limit; follow nextCursor.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.findDependencies(FindDependenciesInputSchema.parse(rawArgs), successDataBudget(maxResultBytes))),
		},
		FindDependenciesInputSchema,
	);

	tool(
		{
			name: 'read_symbol',
			description:
				'Read bounded source for one symbol or list its definition sites, bindings, binding sites, or binding contexts; refuses stale files and reports truncation.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.readSymbol(ReadSymbolInputSchema.parse(rawArgs), successDataBudget(maxResultBytes))),
		},
		ReadSymbolInputSchema,
	);

	tool(
		{
			name: 'symbol_at',
			description: 'Find the innermost stored definition covering a source position or line.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.symbolAt(SymbolAtInputSchema.parse(rawArgs), successDataBudget(maxResultBytes))),
		},
		SymbolAtInputSchema,
	);

	return server;
};
