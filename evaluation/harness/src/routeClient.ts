import {Readable} from 'node:stream';
import {setImmediate as immediate} from 'node:timers/promises';

/** One observed native MCP call. */
export type McpCallOutcomeType = Readonly<{
	tool: string;
	/** `ok` for a success envelope, `error` for a stable tool error. */
	status: 'ok' | 'error';
	/** Round-trip duration from request write to response receipt. */
	elapsedMs: number;
	/** Server-reported handler duration, or null when it was not observed. */
	coreMs: number | null;
	/** UTF-8 bytes of the returned text content. */
	responseBytes: number;
	/** Returned text content, or an empty string when the server returned none. */
	text: string;
	/** Parsed success data or null when no envelope was returned. */
	structured: unknown;
	errorCode: string | null;
	errorMessage: string | null;
}>;

/** One connected artifact session. */
export type McpSessionType = Readonly<{
	serverName: string;
	serverVersion: string;
	/** Milliseconds from process spawn to a completed MCP handshake. */
	startupMs: number;
	callTool: (tool: string, args: Readonly<Record<string, unknown>>) => McpCallOutcomeType | Promise<McpCallOutcomeType>;
	close: () => Promise<void> | void;
}>;

type DebugCompletionType = Readonly<{tool: string; durationMs: number}>;

const COMPLETION_PATTERN = /codeindex:mcp tool call complete \{(?<body>[^{}]*)\}/gu;
const TOOL_PATTERN = /tool: '(?<tool>[^']+)'/u;
const DURATION_PATTERN = /durationMs: (?<duration>\d+)/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Removes and returns observed completion timings from a debug buffer.
 *
 * @param buffer - Mutable debug text buffer.
 * @returns Every complete `tool call complete` record in arrival order.
 */
export const takeDebugTimings = (buffer: {text: string}): readonly DebugCompletionType[] => {
	const timings: DebugCompletionType[] = [];
	const consumed: string[] = [];
	let lastIndex = 0;

	for (const match of buffer.text.matchAll(COMPLETION_PATTERN)) {
		const body = match.groups?.['body'] ?? '';
		const tool = TOOL_PATTERN.exec(body);
		const duration = DURATION_PATTERN.exec(body);
		const toolName = tool?.groups?.['tool'];
		const durationText = duration?.groups?.['duration'];

		if (toolName === undefined || durationText === undefined) {
			continue;
		}

		timings.push({tool: toolName, durationMs: Number(durationText)});

		consumed.push(match[0]);
		lastIndex = match.index + match[0].length;
	}

	if (consumed.length > 0) {
		buffer.text = buffer.text.slice(lastIndex);
	}

	return timings;
};

const textOf = (content: unknown): string => {
	if (!Array.isArray(content)) {
		return '';
	}

	return content.flatMap((item) => (isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string' ? [item['text']] : [])).join('');
};

const envelopeOf = (structured: unknown): Readonly<{ok: boolean; data: unknown; errorCode: string | null; errorMessage: string | null}> => {
	if (!isRecord(structured)) {
		return {ok: true, data: null, errorCode: null, errorMessage: null};
	}

	const error = isRecord(structured['error']) ? structured['error'] : null;

	return {
		ok: structured['ok'] !== false,
		data: structured['data'] ?? null,
		errorCode: typeof error?.['code'] === 'string' ? error['code'] : null,
		errorMessage: typeof error?.['message'] === 'string' ? error['message'] : null,
	};
};

/**
 * Opens the published artifact through the official MCP client over stdio.
 *
 * The artifact runs with diagnostics on stderr, analytics disabled, and no
 * generic Code Mode entry point. The client sees only the native tool catalog.
 *
 * @param input - Artifact entry point, workspace, and optional environment additions.
 * @returns A connected session with per-call timing and byte observations.
 * @throws {@link Error} When the handshake fails.
 */
export const openMcpSession = async (input: Readonly<{entryPoint: string; cwd: string; env?: Readonly<Record<string, string>>}>): Promise<McpSessionType> => {
	// Load the official client only when an artifact session is actually opened.
	// Planning, dry-run, and no-index routes never spawn an MCP process or need
	// the client package at runtime.
	const {Client} = await import('@modelcontextprotocol/client');
	const {getDefaultEnvironment, StdioClientTransport} = await import('@modelcontextprotocol/client/stdio');
	const buffer = {text: ''};
	const startedAt = performance.now();
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [input.entryPoint],
		cwd: input.cwd,
		stderr: 'pipe',
		env: {...getDefaultEnvironment(), CODE_INDEX_ANALYTICS: 'false', CODE_INDEX_LOG_LEVEL: 'error', DEBUG: 'codeindex:mcp', ...input.env},
	});

	const {stderr} = transport;

	if (stderr instanceof Readable) {
		stderr.setEncoding('utf8');
		stderr.on('data', (chunk: string) => {
			buffer.text += chunk;
		});
	}

	const client = new Client({name: 'codeindex-route-comparison', version: '1'});
	await client.connect(transport);
	const startupMs = performance.now() - startedAt;
	const server = client.getServerVersion();

	const callTool = async (tool: string, args: Readonly<Record<string, unknown>>): Promise<McpCallOutcomeType> => {
		const callStart = performance.now();

		try {
			const result: unknown = await client.callTool({name: tool, arguments: {...args}});
			const elapsedMs = performance.now() - callStart;
			const record = isRecord(result) ? result : {};
			const text = textOf(record['content']);
			const envelope = envelopeOf(record['structuredContent']);
			const failed = record['isError'] === true || !envelope.ok;

			await immediate();

			const completion = takeDebugTimings(buffer).find((item) => item.tool === tool);

			return {
				tool,
				status: failed ? 'error' : 'ok',
				elapsedMs,
				coreMs: completion?.durationMs ?? null,
				responseBytes: Buffer.byteLength(text, 'utf8'),
				text,
				structured: envelope.data,
				errorCode: envelope.errorCode ?? (record['isError'] === true ? 'tool_error' : null),
				errorMessage: envelope.errorMessage,
			};
		} catch (error) {
			const elapsedMs = performance.now() - callStart;

			return {
				tool,
				status: 'error',
				elapsedMs,
				coreMs: null,
				responseBytes: 0,
				text: '',
				structured: null,
				errorCode: 'protocol_error',
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
	};

	return {
		serverName: server?.name ?? 'unknown',
		serverVersion: server?.version ?? 'unknown',
		startupMs,
		callTool,
		close: async (): Promise<void> => {
			await client.close();
		},
	};
};
