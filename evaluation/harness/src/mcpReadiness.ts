import {spawn, type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedProcessEnvironmentOf} from './processEnvironment.ts';

/** Closed causes for an MCP server that did not become actually ready. */
export const MCP_READINESS_FAILURE_CAUSES = [
	'spawn-error',
	'server-exited',
	'initialize-timeout',
	'initialize-error',
	'catalog-timeout',
	'catalog-error',
	'catalog-invalid',
	'empty-catalog',
	'duplicate-tools',
	'catalog-mismatch',
] as const;

export type McpReadinessFailureCauseType = (typeof MCP_READINESS_FAILURE_CAUSES)[number];

/** One failed readiness attempt; retained so a reconnect is auditable. */
export type McpReadinessAttemptFailureType = Readonly<{
	attempt: number;
	cause: McpReadinessFailureCauseType;
	detail: string;
}>;

/** Evidence that one configured MCP server completed a real handshake. */
export type McpReadinessType = Readonly<{
	recordType: 'mcp-readiness';
	/** Exact configured command, without environment values. */
	command: readonly string[];
	/** Declared native catalog, sorted; empty when the caller does not pin it. */
	expectedTools: readonly string[];
	attempts: number;
	ready: boolean;
	cause: McpReadinessFailureCauseType | null;
	/** Every failed launch that preceded the final attempt. */
	failures: readonly McpReadinessAttemptFailureType[];
	serverName: string | null;
	serverVersion: string | null;
	tools: readonly string[];
	elapsedMs: number;
}>;

/** Readiness and retry bounds for one configured MCP server. */
export type McpReadinessInputType = Readonly<{
	command: readonly string[];
	cwd: string;
	/** Native tool names the server must present, without the OpenCode server prefix. */
	expectedTools?: readonly string[];
	timeoutMs?: number;
	/** Total launches, including the first. Values below one are treated as one. */
	attempts?: number;
	retryDelayMs?: number;
}>;

type AttemptOutcomeType =
	| Readonly<{ready: true; serverName: string; serverVersion: string; tools: readonly string[]}>
	| Readonly<{ready: false; cause: McpReadinessFailureCauseType; detail: string}>;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const TOOL_NAME = /^\w[\w.:-]*$/iu;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const detailOfExit = (code: number | null, signal: NodeJS.Signals | null): string =>
	code === null && signal === null ? 'server exited without a status' : `server exited with ${code ?? 'no status'}${signal === null ? '' : ` (${signal})`}`;

const toolNamesOf = (result: Record<string, unknown>): readonly string[] => {
	const {tools} = result;

	if (!Array.isArray(tools)) {
		throw new TypeError('catalog-invalid');
	}

	const names = tools.map((item) => {
		if (!isRecord(item) || typeof item['name'] !== 'string' || !TOOL_NAME.test(item['name'])) {
			throw new TypeError('catalog-invalid');
		}

		return item['name'];
	});

	if (names.length === 0) {
		throw new TypeError('empty-catalog');
	}

	if (new Set(names).size !== names.length) {
		throw new TypeError('duplicate-tools');
	}

	return [...names].sort();
};

const serverInfoOf = (result: Record<string, unknown>): Readonly<{serverName: string; serverVersion: string}> => {
	const info = isRecord(result['serverInfo']) ? result['serverInfo'] : {};

	return {
		serverName: typeof info['name'] === 'string' ? info['name'] : 'unknown',
		serverVersion: typeof info['version'] === 'string' ? info['version'] : 'unknown',
	};
};

type ProtocolStateType = {
	expectedTools: readonly string[];
	serverInfo: Readonly<{serverName: string; serverVersion: string}>;
};

type ProtocolHandlersType = Readonly<{
	send: (message: Record<string, unknown>) => void;
	finish: (outcome: AttemptOutcomeType) => void;
	arm: (cause: McpReadinessFailureCauseType) => void;
}>;

const failureCauseOf = (error: unknown): McpReadinessFailureCauseType => {
	const message = error instanceof Error ? error.message : '';
	const known = MCP_READINESS_FAILURE_CAUSES.find((cause) => cause === message);

	return known ?? 'catalog-invalid';
};

const handleProtocolMessageOf = (message: Record<string, unknown>, state: ProtocolStateType, handlers: ProtocolHandlersType): void => {
	const result = isRecord(message['result']) ? message['result'] : null;

	if (message['id'] === 1) {
		if (result === null) {
			handlers.finish({ready: false, cause: 'initialize-error', detail: 'initialize returned no result'});

			return;
		}

		state.serverInfo = serverInfoOf(result);
		handlers.arm('catalog-timeout');
		handlers.send({jsonrpc: '2.0', method: 'notifications/initialized'});
		handlers.send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});

		return;
	}

	if (message['id'] !== 2) {
		return;
	}

	if (result === null) {
		handlers.finish({ready: false, cause: 'catalog-error', detail: 'tools/list returned no result'});

		return;
	}

	let tools: readonly string[];

	try {
		tools = toolNamesOf(result);
	} catch (error) {
		handlers.finish({ready: false, cause: failureCauseOf(error), detail: 'tools/list did not return a valid catalog'});

		return;
	}

	if (state.expectedTools.length > 0 && tools.join('\u0000') !== state.expectedTools.join('\u0000')) {
		handlers.finish({ready: false, cause: 'catalog-mismatch', detail: 'tools/list does not equal the declared native catalog'});

		return;
	}

	handlers.finish({ready: true, ...state.serverInfo, tools});
};

const attemptOf = async (input: McpReadinessInputType): Promise<AttemptOutcomeType> => {
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const expectedTools = [...(input.expectedTools ?? [])].sort();

	if (input.command.length === 0) {
		return {ready: false, cause: 'spawn-error', detail: 'configured command is empty'};
	}

	const [program, ...args] = input.command;

	if (program === undefined) {
		return {ready: false, cause: 'spawn-error', detail: 'configured command is empty'};
	}

	const {promise, resolve} = Promise.withResolvers<AttemptOutcomeType>();
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	let buffer = '';
	const state: ProtocolStateType = {expectedTools, serverInfo: {serverName: 'unknown', serverVersion: 'unknown'}};
	let child: ChildProcess | null = null;

	const finish = (outcome: AttemptOutcomeType): void => {
		if (settled) {
			return;
		}

		settled = true;
		clearTimeout(timer);

		if (child !== null) {
			child.kill('SIGKILL');
		}

		resolve(outcome);
	};

	const arm = (cause: McpReadinessFailureCauseType): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			finish({ready: false, cause, detail: `no response within ${timeoutMs} ms`});
		}, timeoutMs);
	};

	try {
		child = spawn(program, args, {
			cwd: input.cwd,
			env: isolatedProcessEnvironmentOf(),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} catch (error) {
		return {ready: false, cause: 'spawn-error', detail: error instanceof Error ? error.message : String(error)};
	}

	child.on('error', (error: Error) => {
		finish({ready: false, cause: 'spawn-error', detail: error.message});
	});
	child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
		finish({ready: false, cause: 'server-exited', detail: detailOfExit(code, signal)});
	});

	const send = (message: Record<string, unknown>): void => {
		child.stdin?.write(`${JSON.stringify(message)}\n`);
	};
	const handlers: ProtocolHandlersType = {send, finish, arm};

	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		buffer += chunk;

		while (buffer.includes('\n')) {
			const newline = buffer.indexOf('\n');
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);

			if (line.length === 0) {
				continue;
			}

			let message: Record<string, unknown>;

			try {
				const parsed: unknown = JSON.parse(line);

				if (!isRecord(parsed)) {
					continue;
				}

				message = parsed;
			} catch {
				continue;
			}

			handleProtocolMessageOf(message, state, handlers);
		}
	});

	arm('initialize-timeout');
	send({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: {name: 'codeindex-readiness', version: '1'},
		},
	});

	const outcome = await promise;

	return outcome;
};

/**
 * Requires a configured MCP server to complete a real initialize and
 * `tools/list` handshake.
 *
 * Configuring a server, spawning it, or observing a process is not readiness.
 * Readiness is a successful MCP handshake whose complete native catalog
 * matches the expected names. A transient launch failure is retried through a
 * fresh process, so a reconnect is exercised and recorded rather than assumed.
 *
 * @param input - Exact command, working directory, expected catalog, and bounds.
 * @returns The readiness record; inspect `ready` or use {@link assertMcpReady}.
 */
export const probeMcpReadiness = async (input: McpReadinessInputType): Promise<McpReadinessType> => {
	const startedAt = Date.now();
	const expectedTools = [...(input.expectedTools ?? [])].sort();
	const attempts = Math.max(1, input.attempts ?? DEFAULT_ATTEMPTS);
	const retryDelayMs = Math.max(0, input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
	const failures: McpReadinessAttemptFailureType[] = [];
	let last: AttemptOutcomeType = {ready: false, cause: 'spawn-error', detail: 'no launch attempted'};

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		last = await attemptOf(input);

		if (last.ready) {
			return {
				recordType: 'mcp-readiness',
				command: [...input.command],
				expectedTools,
				attempts: attempt,
				ready: true,
				cause: null,
				failures,
				serverName: last.serverName,
				serverVersion: last.serverVersion,
				tools: last.tools,
				elapsedMs: Date.now() - startedAt,
			};
		}

		failures.push({attempt, cause: last.cause, detail: last.detail});

		if (attempt < attempts) {
			await delay(retryDelayMs);
		}
	}

	return {
		recordType: 'mcp-readiness',
		command: [...input.command],
		expectedTools,
		attempts,
		ready: false,
		cause: last.cause,
		failures,
		serverName: null,
		serverVersion: null,
		tools: [],
		elapsedMs: Date.now() - startedAt,
	};
};

/** Error carrying the closed readiness cause and its evidence. */
export class McpReadinessError extends Error {
	public override readonly cause: McpReadinessFailureCauseType;
	public readonly record: McpReadinessType;

	/**
	 * @param record - Failed readiness record.
	 */
	public constructor(record: McpReadinessType) {
		const cause = record.cause ?? 'server-exited';

		super(`MCP server is not ready (${cause}): ${record.failures.at(-1)?.detail ?? 'no detail'}`);
		this.name = 'McpReadinessError';
		this.cause = cause;
		this.record = record;
	}
}

/**
 * Requires a successful, catalog-matching MCP readiness handshake.
 *
 * @param record - Readiness record.
 * @returns The same record when ready.
 * @throws {@link McpReadinessError} When the server never became ready.
 */
export const assertMcpReady = (record: McpReadinessType): McpReadinessType => {
	if (!record.ready) {
		throw new McpReadinessError(record);
	}

	return record;
};
