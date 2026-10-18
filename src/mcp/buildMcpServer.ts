import {McpServer, type ServerContext} from '@modelcontextprotocol/server';
import {type ZodType} from 'zod';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type CodeIndex} from '../index/codeIndex.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../version.ts';
import {errorEnvelope, successDataBudget, successEnvelope, toCallToolResult, type ToolEnvelopeType} from './toolResponses.ts';
import {
	FindDependenciesInputSchema,
	FindReferencesInputSchema,
	FindSymbolInputSchema,
	IndexStatusInputSchema,
	OutlineInputSchema,
	ReadSymbolInputSchema,
} from './toolSchemas.ts';

const debug = debugFor('mcp');

const SERVER_INSTRUCTIONS = `For code navigation in this workspace, use the code index before broad grep or whole-file reads.
Use find_symbol to locate a declaration by name, outline to inspect a known file, find_references to find consumers, find_dependencies to find package usage, and read_symbol to read the smallest useful source range.
For "where is package X used?" or "where do we use package X?", call find_dependencies once with transitive false and compact detail. Do not call index_status first. A current, untruncated direct result is the complete answer: report the returned paths and stop. Do not search manifests, grep source, read the listed files, or expand into downstream consumers unless the question asks for those facts.
Use detail evidence only when import statements, bindings, or locations are requested. Request transitive true only when the question asks about downstream module impact; those results prove authored-module reachability, not binding use. Filter with root to inspect one direct consumer.
Package manifests and lint or build configuration are outside the indexed workspace; use at most one targeted repository search when those facts are required.
Every result reports a generation, explicit freshness, and truncation. Treat current freshness as usable, updating as readable but possibly stale, and stale or unknown as a fallback trigger.
Paginated limits are upper bounds; follow nextCursor whenever truncated is true.
Fall back to normal repository tools when the index reports stale data, incomplete scope, an unknown symbol, or no match.
The index covers the sources selected by the configured extractor project; other project contexts and languages are outside its scope.`;

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
 * Builds the local stdio MCP server that exposes the six read-only index tools.
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
	const {index, logger, maxResultBytes} = input;
	const analytics = input.analytics ?? null;
	debug('mcp server built', {name: PROGRAM_NAME, version: PROGRAM_VERSION, maxResultBytes});

	register(
		server,
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

	register(
		server,
		{
			name: 'outline',
			description: 'List declarations defined in one indexed file, in source order.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.getOutline(OutlineInputSchema.parse(rawArgs), successDataBudget(maxResultBytes))),
		},
		OutlineInputSchema,
	);

	register(
		server,
		{
			name: 'find_symbol',
			description: 'Find a declaration by exact qualified name, exact simple name, or name prefix.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.findSymbols(FindSymbolInputSchema.parse(rawArgs), successDataBudget(maxResultBytes))),
		},
		FindSymbolInputSchema,
	);

	register(
		server,
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

	register(
		server,
		{
			name: 'find_dependencies',
			description:
				'Find authored modules that import an npm package. For direct usage, call once with transitive false and compact detail; a current untruncated result is the complete answer. Transitive mode returns module impact grouped by direct root. Pages may be shortened to the response byte limit; follow nextCursor.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.findDependencies(FindDependenciesInputSchema.parse(rawArgs), successDataBudget(maxResultBytes))),
		},
		FindDependenciesInputSchema,
	);

	register(
		server,
		{
			name: 'read_symbol',
			description: 'Read bounded source for one symbol; refuses stale files and reports truncation.',
			maxResultBytes,
			logger,
			analytics,
			invoke: (rawArgs) => successEnvelope(index.readSymbol(ReadSymbolInputSchema.parse(rawArgs))),
		},
		ReadSymbolInputSchema,
	);

	return server;
};
