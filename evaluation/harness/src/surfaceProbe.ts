import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type IncomingMessage, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isolatedProcessEnvironmentOf} from './processEnvironment.ts';
import {type ToolSurfaceType} from './treatment.ts';

/** Tool names a provider request carried. */
export type CapturedSurfaceType = Readonly<{
	tools: readonly string[];
	/** Requests that carried a tool list; title generation does not. */
	agentRequests: number;
	/** Requests OpenCode made without tools, normally session-title generation. */
	titleRequests: number;
}>;

/** Provider and model used only by the model-free surface probe. */
const PROBE_PROVIDER = 'surface-probe';
const PROBE_MODEL = 'probe';

/** The probe asks for a response that cannot satisfy the evaluator prompt. */
const PROBE_PROMPT = 'Reply with the JSON object {"files":[],"absent":true} and nothing else.';

/** Turns the probe answers with a tool call before it must see a stable surface. */
const MAX_AGENT_TURNS = 8;

/** Upper bound for one probe, including MCP startup and catalog listing. */
const PROBE_TIMEOUT_MS = 120_000;

/** Grace before a probe child group is killed outright. */
const TERMINATE_GRACE_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the tool names a provider request carried.
 *
 * @param body - Parsed request body.
 * @returns Tool names in request order; empty for a request without tools.
 */
export const requestToolNamesOf = (body: unknown): readonly string[] => {
	const tools = isRecord(body) ? body['tools'] : undefined;

	if (tools === undefined) {
		return [];
	}

	if (!Array.isArray(tools)) {
		throw new Error('provider request field "tools" must be an array');
	}

	return tools.map((tool) => {
		const name = isRecord(tool) && isRecord(tool['function']) ? tool['function']['name'] : undefined;

		if (typeof name !== 'string' || name.length === 0) {
			throw new Error('provider request contains a tool without a function name');
		}

		return name;
	});
};

/**
 * Summarizes the union of every tool list observed in a probe.
 *
 * @param requests - Parsed provider request bodies in order.
 * @returns Observable surface summary.
 */
export const capturedSurfaceOf = (requests: readonly unknown[]): CapturedSurfaceType => {
	const tools = new Set<string>();
	let agentRequests = 0;
	let titleRequests = 0;

	for (const request of requests) {
		const names = requestToolNamesOf(request);

		if (names.length === 0) {
			titleRequests += 1;
			continue;
		}

		agentRequests += 1;

		for (const name of names) {
			tools.add(name);
		}
	}

	return {tools: [...tools].sort(), agentRequests, titleRequests};
};

const sse = (response: import('node:http').ServerResponse, payload: unknown): void => {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const textResponseOf = (response: import('node:http').ServerResponse, text: string): void => {
	const base = {id: 'chatcmpl-surface-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: PROBE_MODEL};
	response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
	sse(response, {...base, choices: [{index: 0, delta: {role: 'assistant', content: text}, finish_reason: null}]});
	sse(response, {...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
	response.end('data: [DONE]\n\n');
};

const toolCallResponseOf = (response: import('node:http').ServerResponse, turn: number): void => {
	const base = {id: `chatcmpl-surface-probe-${turn}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: PROBE_MODEL};
	const call = {
		...base,
		choices: [
			{
				index: 0,
				delta: {
					role: 'assistant',
					tool_calls: [{index: 0, id: `call-surface-probe-${turn}`, type: 'function', function: {name: 'read', arguments: '{"path":"README.md"}'}}],
				},
				finish_reason: null,
			},
		],
	};
	response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
	sse(response, call);
	sse(response, {...base, choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]});
	response.end('data: [DONE]\n\n');
};

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
	if (child.pid === undefined) {
		return;
	}

	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
};

const readBodyOf = (request: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		let body = '';

		request.setEncoding('utf8');
		request.on('data', (chunk: string) => {
			body += chunk;
		});
		request.on('end', () => resolve(body));
		request.on('error', reject);
	});

/**
 * Captures the exact tool list OpenCode sends to a provider.
 *
 * The probe starts a loopback OpenAI-compatible endpoint and points a private
 * `surface-probe` provider at it through `OPENCODE_CONFIG_CONTENT`; the workspace
 * configuration, agent, artifact, and MCP server are untouched. No model runs:
 * the endpoint answers the title request, then a few read calls, and finally a
 * terminal text response. Every request body is recorded, and the union of the
 * observed tool names is the surface OpenCode presented.
 *
 * @param input - Workspace, declared surface, executable, and optional timeout.
 * @returns The observed tool names.
 */
export const capturePresentedTools = async (
	input: Readonly<{
		workspace: string;
		surface: ToolSurfaceType;
		command?: string;
		timeoutMs?: number;
	}>,
): Promise<CapturedSurfaceType> => {
	const workspace = path.resolve(input.workspace);
	const dataHome = mkdtempSync(path.join(tmpdir(), 'codeindex-surface-'));
	let child: ChildProcess | null = null;
	let server: Server | null = null;
	let settle: () => void = () => undefined;

	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});

	const observedTools = new Set<string>();
	let lastSignature: string | null = null;
	let stableTurns = 0;
	let agentTurns = 0;
	let titleTurns = 0;
	let failure: Error | null = null;
	const startedAt = Date.now();

	/** MCP tools arrive only after the server connects, which is asynchronous. */
	const MCP_SETTLE_MS = 3_000;
	/** Delay between probe turns so a connecting MCP server can publish its catalog. */
	const TURN_DELAY_MS = 600;

	const record = (body: unknown): 'title' | 'agent' => {
		const names = requestToolNamesOf(body);

		if (names.length === 0) {
			titleTurns += 1;

			return 'title';
		}

		agentTurns += 1;

		for (const name of names) {
			observedTools.add(name);
		}

		const signature = [...names].sort().join('\n');
		stableTurns = signature === lastSignature ? stableTurns + 1 : 0;
		lastSignature = signature;

		return 'agent';
	};

	server = createServer((request, response) => {
		void (async () => {
			try {
				const body = await readBodyOf(request);

				if (request.url?.endsWith('/chat/completions') !== true) {
					response.writeHead(404, {'content-type': 'application/json'});
					response.end('{}');

					return;
				}

				const parsed: unknown = JSON.parse(body);
				const kind = record(parsed);
				// MCP tools appear only after the server connects, which can be later
				// than the first agent turn. Require several turns, a stable list, and
				// enough elapsed time for a connecting server to publish its catalog.
				const complete =
					kind === 'agent' && ((agentTurns >= 3 && stableTurns >= 1 && Date.now() - startedAt >= MCP_SETTLE_MS) || agentTurns >= MAX_AGENT_TURNS);

				if (complete) {
					textResponseOf(response, '{"files":[],"absent":true}');
					settle();

					return;
				}

				if (kind === 'agent') {
					await new Promise<void>((resolve) => {
						setTimeout(resolve, TURN_DELAY_MS);
					});
					toolCallResponseOf(response, agentTurns);

					return;
				}

				textResponseOf(response, '{}');
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
				response.writeHead(500, {'content-type': 'application/json'});
				response.end('{}');
				settle();
			}
		})();
	});

	const listening = await new Promise<number>((resolve, reject) => {
		server?.once('error', reject);
		server?.listen(0, '127.0.0.1', () => {
			const address = server?.address();

			if (address === null || address === undefined || typeof address === 'string') {
				reject(new Error('surface probe server did not bind a TCP port'));

				return;
			}

			resolve(address.port);
		});
	});

	const config = {
		providers: {
			[PROBE_PROVIDER]: {
				name: 'Surface Probe',
				package: 'aisdk:@ai-sdk/openai-compatible',
				settings: {baseURL: `http://127.0.0.1:${listening}/v1`},
				models: {[PROBE_MODEL]: {}},
			},
		},
	};
	const environment = isolatedProcessEnvironmentOf({
		PWD: workspace,
		OPENCODE_DB: ':memory:',
		OPENCODE_DISABLE_TELEMETRY: '1',
		XDG_DATA_HOME: dataHome,
		OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
	});

	delete environment['OPENCODE_SESSION_ID'];

	let stderr = '';

	try {
		child = spawn(
			input.command ?? 'opencode',
			['run', '--standalone', '--agent', 'evaluator', '--model', `${PROBE_PROVIDER}/${PROBE_MODEL}`, '--format', 'json', '--auto', PROBE_PROMPT],
			{cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'},
		);
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', (error) => {
			failure = error;
			settle();
		});
		child.on('close', () => {
			settle();
		});

		const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<'timed-out'>((resolve) => {
			timer = setTimeout(() => resolve('timed-out'), timeoutMs);
		});
		const outcome = await Promise.race([settled.then(() => 'settled' as const), timedOut]);

		clearTimeout(timer);

		if (failure !== null) {
			throw failure;
		}

		if (outcome === 'timed-out') {
			throw new Error(`surface probe timed out after ${timeoutMs} ms; stderr: ${stderr.slice(-2_000)}`);
		}

		if (agentTurns === 0) {
			throw new Error(`surface probe observed no tool-bearing request; stderr: ${stderr.slice(-2_000)}`);
		}

		return {tools: [...observedTools].sort(), agentRequests: agentTurns, titleRequests: titleTurns};
	} finally {
		if (child !== null) {
			signalGroup(child, 'SIGTERM');

			const deadline = Date.now() + TERMINATE_GRACE_MS;

			while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 50);
				});
			}

			if (child.exitCode === null && child.signalCode === null) {
				signalGroup(child, 'SIGKILL');
			}
		}

		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server?.close(() => resolve());
		});
		rmSync(dataHome, {recursive: true, force: true});
	}
};
