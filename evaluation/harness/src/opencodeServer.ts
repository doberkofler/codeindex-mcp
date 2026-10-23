import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {signalGroup} from './childProcess.ts';

/** Closed causes for an OpenCode server that cannot admit a prompt safely. */
export const OPEN_CODE_SERVER_FAILURE_CAUSES = [
	'server-start-timeout',
	'server-exited',
	'server-http-error',
	'mcp-status-unavailable',
	'mcp-connect-failed',
	'mcp-readiness-timeout',
] as const;

export type OpenCodeServerFailureCauseType = (typeof OPEN_CODE_SERVER_FAILURE_CAUSES)[number];

/** One configured MCP server and the status OpenCode reports for it. */
export type OpenCodeMcpServerStatusType = Readonly<{
	name: string;
	status: 'connected' | 'pending' | 'failed' | 'unknown';
	detail: string | null;
}>;

/** Direct evidence that OpenCode connected every configured MCP server. */
export type OpenCodeMcpReadinessType = Readonly<{
	recordType: 'opencode-mcp-readiness';
	expectedServers: readonly string[];
	attempts: number;
	ready: boolean;
	cause: OpenCodeServerFailureCauseType | null;
	servers: readonly OpenCodeMcpServerStatusType[];
	elapsedMs: number;
}>;

/** A running private OpenCode server that can accept a gated prompt. */
export type OpenCodeServerType = Readonly<{
	url: string;
	/** Printed server password. Never written to evidence. */
	password: string;
	/**
	 * Waits until OpenCode reports every expected MCP server as connected.
	 *
	 * A failed status is retried until the bound so a reconnect can recover.
	 * Registration, process existence, or a pending status alone is never ready.
	 */
	awaitMcpReady: (expectedServers: readonly string[], timeoutMs?: number) => Promise<OpenCodeMcpReadinessType>;
	close: () => Promise<void>;
}>;

export type OpenCodeServerInputType = Readonly<{
	cwd: string;
	/** Complete isolated environment for the server process. */
	env: NodeJS.ProcessEnv;
	/** Command override for deterministic tests. */
	command?: string;
	startTimeoutMs?: number;
}>;

const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const READINESS_POLL_MS = 100;
const CLOSE_GRACE_MS = 1000;
const MCP_DISCONNECT_TIMEOUT_MS = 5000;
const SERVER_URL = /server listening on (?<url>http:\/\/\S+)/u;
const SERVER_PASSWORD = /server password (?<password>\S+)/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const serverStatusOf = (value: unknown): OpenCodeMcpServerStatusType | null => {
	if (!isRecord(value) || typeof value['name'] !== 'string') {
		return null;
	}

	const status = isRecord(value['status']) ? value['status']['status'] : undefined;
	const detail = isRecord(value['status']) && typeof value['status']['message'] === 'string' ? value['status']['message'].slice(0, 500) : null;

	if (status === 'connected' || status === 'pending' || status === 'failed') {
		return {name: value['name'], status, detail};
	}

	return {name: value['name'], status: 'unknown', detail};
};

/** Error carrying a closed cause and the latest MCP status evidence. */
export class OpenCodeServerError extends Error {
	public override readonly cause: OpenCodeServerFailureCauseType;
	public readonly readiness: OpenCodeMcpReadinessType | null;

	/**
	 * @param cause - Closed failure cause.
	 * @param detail - Bounded diagnostic.
	 * @param readiness - Latest readiness record, when the server started.
	 */
	public constructor(cause: OpenCodeServerFailureCauseType, detail: string, readiness: OpenCodeMcpReadinessType | null = null) {
		super(`OpenCode could not admit a prompt (${cause}): ${detail}`);
		this.name = 'OpenCodeServerError';
		this.cause = cause;
		this.readiness = readiness;
	}
}

const waitForEndpointOf = async (child: ChildProcess, timeoutMs: number): Promise<Readonly<{url: string; password: string}>> => {
	const {promise, resolve, reject} = Promise.withResolvers<Readonly<{url: string; password: string}>>();
	let stdout = '';
	const timer = setTimeout(() => {
		reject(new OpenCodeServerError('server-start-timeout', `no endpoint within ${timeoutMs} ms`));
	}, timeoutMs);

	const settle = (): void => {
		const url = SERVER_URL.exec(stdout)?.groups?.['url'];
		const password = SERVER_PASSWORD.exec(stdout)?.groups?.['password'] ?? process.env['OPENCODE_PASSWORD'] ?? process.env['OPENCODE_SERVER_PASSWORD'] ?? '';

		if (url !== undefined && password.length > 0) {
			clearTimeout(timer);
			child.stdout?.removeAllListeners('data');
			child.stdout?.resume();
			resolve({url, password});
		}
	};

	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		stdout += chunk;
		settle();
	});
	child.once('error', (error: Error) => {
		clearTimeout(timer);
		reject(new OpenCodeServerError('server-exited', error.message));
	});
	child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
		clearTimeout(timer);
		reject(new OpenCodeServerError('server-exited', `server exited with ${code ?? signal ?? 'no status'} before reporting an endpoint`));
	});

	const endpoint = await promise;

	return endpoint;
};

const authorizationOf = (password: string): string => `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

const fetchStatusOf = async (input: Readonly<{url: string; password: string}>): Promise<readonly OpenCodeMcpServerStatusType[]> => {
	const response = await fetch(`${input.url}/api/mcp`, {
		headers: {authorization: authorizationOf(input.password)},
		signal: AbortSignal.timeout(2000),
	});

	if (!response.ok) {
		throw new Error(`status endpoint returned HTTP ${response.status}`);
	}

	const parsed: unknown = await response.json();
	const data = isRecord(parsed) ? parsed['data'] : undefined;

	if (!Array.isArray(data)) {
		throw new TypeError('status endpoint returned no data array');
	}

	return data.flatMap((item) => {
		const status = serverStatusOf(item);

		return status === null ? [] : [status];
	});
};

const disconnectMcpServersOf = async (input: Readonly<{url: string; password: string}>): Promise<void> => {
	const servers = await fetchStatusOf(input);
	const authorization = authorizationOf(input.password);

	await Promise.all(
		servers.map(async (server) => {
			const response = await fetch(`${input.url}/api/experimental/mcp/${encodeURIComponent(server.name)}/disconnect`, {
				method: 'POST',
				headers: {authorization},
				signal: AbortSignal.timeout(MCP_DISCONNECT_TIMEOUT_MS),
			});

			if (!response.ok) {
				throw new Error(`MCP disconnect for ${server.name} returned HTTP ${response.status}`);
			}
		}),
	);
};

const readinessFailureOf = (
	input: Readonly<{
		expectedServers: readonly string[];
		attempts: number;
		startedAt: number;
		servers: readonly OpenCodeMcpServerStatusType[];
		cause: OpenCodeServerFailureCauseType;
	}>,
): OpenCodeMcpReadinessType => ({
	recordType: 'opencode-mcp-readiness',
	expectedServers: input.expectedServers,
	attempts: input.attempts,
	ready: false,
	cause: input.cause,
	servers: input.servers,
	elapsedMs: Date.now() - input.startedAt,
});

const isRunningOf = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

const closeServerOf = async (child: ChildProcess): Promise<void> => {
	if (!isRunningOf(child)) {
		return;
	}

	signalGroup(child, 'SIGTERM');

	const deadline = Date.now() + CLOSE_GRACE_MS;

	while (isRunningOf(child) && Date.now() < deadline) {
		await delay(25);
	}

	if (isRunningOf(child)) {
		signalGroup(child, 'SIGKILL');
	}

	await Promise.race([once(child, 'close'), delay(CLOSE_GRACE_MS)]);
};

/**
 * Starts a private OpenCode server and exposes a readiness-gated endpoint.
 *
 * A prompt may be admitted only after {@link OpenCodeServerType.awaitMcpReady}
 * reports every expected MCP server as connected. Starting the process or
 * registering a server in configuration is not readiness.
 *
 * @param input - Workspace, isolated environment, command override, and bound.
 * @returns The running server, its readiness gate, and a bounded close.
 * @throws {@link OpenCodeServerError} When no endpoint is reported in time.
 */
export const startOpenCodeServer = async (input: OpenCodeServerInputType): Promise<OpenCodeServerType> => {
	const child = spawn(input.command ?? 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
		cwd: input.cwd,
		env: input.env,
		stdio: ['ignore', 'pipe', 'ignore'],
		detached: process.platform !== 'win32',
	});

	let endpoint: Readonly<{url: string; password: string}>;

	try {
		endpoint = await waitForEndpointOf(child, input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
	} catch (error) {
		await closeServerOf(child);
		throw error;
	}

	return {
		url: endpoint.url,
		password: endpoint.password,
		awaitMcpReady: async (expectedServers, timeoutMs = DEFAULT_READINESS_TIMEOUT_MS) => {
			const startedAt = Date.now();
			const expected = [...new Set(expectedServers)].sort();
			const deadline = startedAt + timeoutMs;
			let attempts = 0;
			let servers: readonly OpenCodeMcpServerStatusType[] = [];
			let sawFailure = false;

			while (Date.now() < deadline) {
				if (child.exitCode !== null || child.signalCode !== null) {
					return readinessFailureOf({expectedServers: expected, attempts, startedAt, servers, cause: 'server-exited'});
				}

				attempts += 1;

				try {
					servers = await fetchStatusOf(endpoint);
				} catch {
					await delay(READINESS_POLL_MS);

					continue;
				}

				if (expected.length === 0) {
					return {
						recordType: 'opencode-mcp-readiness',
						expectedServers: expected,
						attempts,
						ready: true,
						cause: null,
						servers,
						elapsedMs: Date.now() - startedAt,
					};
				}

				const byName = new Map(servers.map((server) => [server.name, server]));
				const failed = expected.filter((name) => byName.get(name)?.status === 'failed');
				const missing = expected.filter((name) => byName.get(name)?.status !== 'connected');

				sawFailure ||= failed.length > 0;

				if (missing.length === 0) {
					return {
						recordType: 'opencode-mcp-readiness',
						expectedServers: expected,
						attempts,
						ready: true,
						cause: null,
						servers,
						elapsedMs: Date.now() - startedAt,
					};
				}

				await delay(READINESS_POLL_MS);
			}

			return readinessFailureOf({
				expectedServers: expected,
				attempts,
				startedAt,
				servers,
				cause: sawFailure ? 'mcp-connect-failed' : 'mcp-readiness-timeout',
			});
		},
		close: async () => {
			try {
				await disconnectMcpServersOf(endpoint);
			} finally {
				await closeServerOf(child);
			}
		},
	};
};

/**
 * Starts a server and requires every expected MCP server to be connected.
 *
 * @param input - Workspace, environment, expected servers, and bounds.
 * @returns The ready server and its evidence.
 * @throws {@link OpenCodeServerError} With a closed cause when not ready.
 */
export const openReadyServerOf = async (
	input: OpenCodeServerInputType & Readonly<{expectedServers: readonly string[]; readinessTimeoutMs?: number}>,
): Promise<Readonly<{server: OpenCodeServerType; readiness: OpenCodeMcpReadinessType}>> => {
	const server = await startOpenCodeServer(input);
	const readiness = await server.awaitMcpReady(input.expectedServers, input.readinessTimeoutMs);

	if (!readiness.ready) {
		await server.close();
		throw new OpenCodeServerError(readiness.cause ?? 'mcp-readiness-timeout', 'expected MCP servers are not connected', readiness);
	}

	return {server, readiness};
};
