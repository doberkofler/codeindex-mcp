import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
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
const TERMINATE_GRACE_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the tool names a provider request carried.
 *
 * @param body - Parsed request body.
 * @returns Tool names in request order; empty for a request without tools.
 */
export const requestToolNamesOf = (body: unknown): readonly string[] => {
	const tools = isRecord(body) ? body.tools : undefined;

	if (tools === undefined) {
		return [];
	}

	if (!Array.isArray(tools)) {
		throw new TypeError('provider request field "tools" must be an array');
	}

	return tools.map((tool) => {
		const name = isRecord(tool) && isRecord(tool.function) ? tool.function.name : undefined;

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

const sse = (response: ServerResponse, payload: unknown): void => {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const textResponseOf = (response: ServerResponse, text: string): void => {
	const base = {id: 'chatcmpl-surface-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: PROBE_MODEL};
	response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
	sse(response, {...base, choices: [{index: 0, delta: {role: 'assistant', content: text}, finish_reason: null}]});
	sse(response, {...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
	response.end('data: [DONE]\n\n');
};

const toolCallResponseOf = (response: ServerResponse, turn: number): void => {
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

const readBodyOf = async (request: IncomingMessage): Promise<string> => {
	request.setEncoding('utf8');
	let body = '';

	for await (const chunk of request) {
		body += String(chunk);
	}

	return body;
};

/** Counters and observations accumulated across probe turns. */
type ProbeStateType = {
	observedTools: Set<string>;
	lastSignature: string | null;
	stableTurns: number;
	agentTurns: number;
	titleTurns: number;
};

/** MCP tools arrive only after the server connects, which is asynchronous. */
const MCP_SETTLE_MS = 3000;
/** Delay between probe turns so a connecting MCP server can publish its catalog. */
const TURN_DELAY_MS = 600;
/** Turns after which the probe stops waiting for a stable tool list. */
const MIN_AGENT_TURNS = 3;

const stateOf = (): ProbeStateType => ({observedTools: new Set<string>(), lastSignature: null, stableTurns: 0, agentTurns: 0, titleTurns: 0});

const recordRequestOf = (state: ProbeStateType, body: unknown): 'title' | 'agent' => {
	const names = requestToolNamesOf(body);

	if (names.length === 0) {
		state.titleTurns += 1;

		return 'title';
	}

	state.agentTurns += 1;

	for (const name of names) {
		state.observedTools.add(name);
	}

	const signature = [...names].sort().join('\n');

	state.stableTurns = signature === state.lastSignature ? state.stableTurns + 1 : 0;
	state.lastSignature = signature;

	return 'agent';
};

const respondToProbeOf = async (
	input: Readonly<{
		request: IncomingMessage;
		response: ServerResponse;
		state: ProbeStateType;
		settle: (error: Error | null) => void;
		startedAt: number;
	}>,
): Promise<void> => {
	try {
		const body = await readBodyOf(input.request);

		if (input.request.url?.endsWith('/chat/completions') !== true) {
			input.response.writeHead(404, {'content-type': 'application/json'});
			input.response.end('{}');

			return;
		}

		const parsed: unknown = JSON.parse(body);
		const kind = recordRequestOf(input.state, parsed);
		// MCP tools appear only after the server connects, which can be later
		// than the first agent turn. Require several turns, a stable list, and
		// enough elapsed time for a connecting server to publish its catalog.
		const settledTurns = input.state.agentTurns >= MIN_AGENT_TURNS && input.state.stableTurns >= 1 && Date.now() - input.startedAt >= MCP_SETTLE_MS;
		const complete = kind === 'agent' && (settledTurns || input.state.agentTurns >= MAX_AGENT_TURNS);

		if (complete) {
			textResponseOf(input.response, '{"files":[],"absent":true}');
			input.settle(null);

			return;
		}

		if (kind === 'agent') {
			await delay(TURN_DELAY_MS);
			toolCallResponseOf(input.response, input.state.agentTurns);

			return;
		}

		textResponseOf(input.response, '{}');
	} catch (error) {
		input.settle(error instanceof Error ? error : new Error(String(error)));
		input.response.writeHead(500, {'content-type': 'application/json'});
		input.response.end('{}');
	}
};

const probeServerOf = async (
	state: ProbeStateType,
	settle: (error: Error | null) => void,
	startedAt: number,
): Promise<Readonly<{server: Server; port: number}>> => {
	const server = createServer((request, response) => {
		void respondToProbeOf({request, response, state, settle, startedAt});
	});
	const listening = Promise.withResolvers<number>();

	server.once('error', (error: Error) => {
		listening.reject(error);
	});
	server.listen(0, '127.0.0.1', () => {
		const address = server.address();

		if (address === null || typeof address === 'string') {
			listening.reject(new Error('surface probe server did not bind a TCP port'));

			return;
		}

		listening.resolve(address.port);
	});

	return {server, port: await listening.promise};
};

const probeConfigOf = (port: number): Readonly<{providers: Readonly<Record<string, unknown>>}> => ({
	providers: {
		[PROBE_PROVIDER]: {
			name: 'Surface Probe',
			package: 'aisdk:@ai-sdk/openai-compatible',
			settings: {baseURL: `http://127.0.0.1:${port}/v1`},
			models: {[PROBE_MODEL]: {}},
		},
	},
});

const awaitProbeOf = async (
	input: Readonly<{settled: Promise<Error | null>; timeoutMs: number; state: ProbeStateType; stderrOf: () => string}>,
): Promise<void> => {
	const timeout = Promise.withResolvers<'timed-out'>();
	const timer = setTimeout(() => {
		timeout.resolve('timed-out');
	}, input.timeoutMs);
	const outcome = await Promise.race([input.settled.then((reason) => ({kind: 'settled' as const, failure: reason})), timeout.promise]);

	clearTimeout(timer);

	if (typeof outcome !== 'string' && outcome.failure !== null) {
		throw outcome.failure;
	}

	if (outcome === 'timed-out') {
		throw new Error(`surface probe timed out after ${input.timeoutMs} ms; stderr: ${input.stderrOf()}`);
	}

	if (input.state.agentTurns === 0) {
		throw new Error(`surface probe observed no tool-bearing request; stderr: ${input.stderrOf()}`);
	}
};

const terminateProbeOf = async (child: ChildProcess): Promise<void> => {
	signalGroup(child, 'SIGTERM');

	const deadline = Date.now() + TERMINATE_GRACE_MS;

	while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
		await delay(50);
	}

	if (child.exitCode === null && child.signalCode === null) {
		signalGroup(child, 'SIGKILL');
	}
};

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
	const state = stateOf();
	const startedAt = Date.now();
	const {promise: settled, resolve: settle} = Promise.withResolvers<Error | null>();
	const {server, port} = await probeServerOf(state, settle, startedAt);
	let child: ChildProcess | null = null;

	try {
		const environment = isolatedProcessEnvironmentOf({
			PWD: workspace,
			OPENCODE_DB: ':memory:',
			OPENCODE_DISABLE_TELEMETRY: '1',
			XDG_DATA_HOME: dataHome,
			OPENCODE_CONFIG_CONTENT: JSON.stringify(probeConfigOf(port)),
		});

		delete environment['OPENCODE_SESSION_ID'];

		let stderr = '';

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
			settle(error);
		});
		child.on('close', () => {
			settle(null);
		});

		await awaitProbeOf({
			settled,
			timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
			state,
			stderrOf: () => stderr.slice(-2000),
		});

		return {tools: [...state.observedTools].sort(), agentRequests: state.agentTurns, titleRequests: state.titleTurns};
	} finally {
		if (child !== null) {
			await terminateProbeOf(child);
		}

		server.closeAllConnections();
		const closed = once(server, 'close');

		server.close();
		await closed;
		rmSync(dataHome, {recursive: true, force: true});
	}
};
