import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedProcessEnvironmentOf} from './processEnvironment.ts';
import {openReadyServerOf, type OpenCodeMcpReadinessType, type OpenCodeServerType} from './opencodeServer.ts';
import {pathDisclosureCountOf} from './pathDisclosure.ts';
import {providerRequestKindOf} from './providerRequestKind.ts';
import {assertRequestOneSurface, type SurfaceRequestLedgerType, type SurfaceRequestType} from './requestSurface.ts';
import {type ToolSurfaceType} from './treatment.ts';

/** The direct agent request-1 capture and its ledger. */
export type CapturedSurfaceType = Readonly<{
	/** Tool names offered on agent request 1, in request order. */
	tools: readonly string[];
	agentRequests: number;
	/** Requests OpenCode made without tools, normally session-title generation. */
	titleRequests: number;
	/** Every provider request admitted by this cold start, in ordinal order. */
	requests: readonly SurfaceRequestType[];
	ledger: SurfaceRequestLedgerType;
	/** OpenCode's own MCP readiness evidence; null for the deterministic command seam. */
	serverReadiness: OpenCodeMcpReadinessType | null;
}>;

/** Provider and model used only by the model-free surface probe. */
const PROBE_PROVIDER = 'surface-probe';
const PROBE_MODEL = 'probe';

/** The probe asks for a response that cannot satisfy the evaluator prompt. */
const PROBE_PROMPT = 'Reply with the JSON object {"files":[],"absent":true} and nothing else.';

/** Upper bound for one probe, including MCP startup and catalog listing. */
const PROBE_TIMEOUT_MS = 120_000;

/** Grace before a probe child group is killed outright. */
const TERMINATE_GRACE_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the tool names a provider request carried.
 *
 * Duplicate names are preserved so the request-1 assertion can reject them.
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
		throw new TypeError('provider request field "tools" must be an array');
	}

	return tools.map((tool) => {
		const name = isRecord(tool) && isRecord(tool['function']) ? tool['function']['name'] : undefined;

		if (typeof name !== 'string' || name.length === 0) {
			throw new Error('provider request contains a tool without a function name');
		}

		return name;
	});
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

/** Provider requests accumulated during one probe. */
type ProbeStateType = Readonly<{requests: SurfaceRequestType[]; forbiddenRoots: readonly string[]}>;

const respondToProbeOf = async (
	input: Readonly<{
		request: IncomingMessage;
		response: ServerResponse;
		state: ProbeStateType;
		settle: (error: Error | null) => void;
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
		const ordinal = input.state.requests.length + 1;
		const kind = providerRequestKindOf(parsed, input.request.headers, {agentPrompt: PROBE_PROMPT});
		const toolNames = requestToolNamesOf(parsed);
		const pathDisclosureCount = pathDisclosureCountOf(body, input.state.forbiddenRoots);

		input.state.requests.push({ordinal, kind, toolNames, pathDisclosureCount});

		if (kind === 'agent') {
			// The first agent request is the only turn that decides the verdict.
			// Answering it immediately prevents a later turn from repairing a
			// surface that was absent when the prompt was admitted.
			textResponseOf(input.response, '{"files":[],"absent":true}');
			input.settle(null);

			return;
		}

		// Session-title and other auxiliary requests are acknowledged without
		// contributing tools to the agent request-1 verdict.
		textResponseOf(input.response, '{}');
	} catch (error) {
		input.settle(error instanceof Error ? error : new Error(String(error)));
		input.response.writeHead(500, {'content-type': 'application/json'});
		input.response.end('{}');
	}
};

const probeServerOf = async (state: ProbeStateType, settle: (error: Error | null) => void): Promise<Readonly<{server: Server; port: number}>> => {
	const server = createServer((request, response) => {
		void respondToProbeOf({request, response, state, settle});
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

type ProbeInvocationType = Readonly<{
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	openCode: OpenCodeServerType | null;
	serverReadiness: OpenCodeMcpReadinessType | null;
}>;

const invocationOf = async (
	input: Readonly<{workspace: string; surface: ToolSurfaceType; mcpServer?: string; command?: string; serverCommand?: string}>,
	dataHome: string,
	port: number,
): Promise<ProbeInvocationType> => {
	const environment = isolatedProcessEnvironmentOf({
		PWD: input.workspace,
		OPENCODE_DB: ':memory:',
		OPENCODE_DISABLE_TELEMETRY: '1',
		XDG_DATA_HOME: dataHome,
		OPENCODE_CONFIG_CONTENT: JSON.stringify(probeConfigOf(port)),
	});

	delete environment['OPENCODE_SESSION_ID'];

	if (input.command !== undefined) {
		return {
			args: ['run', '--standalone', '--agent', 'evaluator', '--model', `${PROBE_PROVIDER}/${PROBE_MODEL}`, '--format', 'json', '--auto', PROBE_PROMPT],
			env: environment,
			openCode: null,
			serverReadiness: null,
		};
	}

	if (input.surface.codeIndex.length > 0 && input.mcpServer === undefined) {
		throw new Error(`surface ${input.surface.treatmentId} requires the configured MCP server name`);
	}

	// The prompt is admitted only after OpenCode reports the configured server
	// connected. Starting a process or registering a server is not enough: the
	// prompt-producing `run` connects to this ready server.
	const ready = await openReadyServerOf({
		cwd: input.workspace,
		env: environment,
		expectedServers: input.mcpServer === undefined ? [] : [input.mcpServer],
		...(input.serverCommand === undefined ? {} : {command: input.serverCommand}),
	});

	return {
		args: [
			'run',
			'--server',
			ready.server.url,
			'--agent',
			'evaluator',
			'--model',
			`${PROBE_PROVIDER}/${PROBE_MODEL}`,
			'--format',
			'json',
			'--auto',
			PROBE_PROMPT,
		],
		env: {...environment, OPENCODE_SERVER_PASSWORD: ready.server.password},
		openCode: ready.server,
		serverReadiness: ready.readiness,
	};
};

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

	if (!input.state.requests.some((request) => request.kind === 'agent')) {
		throw new Error(`surface probe admitted no agent request; stderr: ${input.stderrOf()}`);
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
 * Captures and asserts the exact tool list OpenCode offers on agent request 1.
 *
 * The probe starts a fresh loopback OpenAI-compatible endpoint and points a
 * private `surface-probe` provider at it through `OPENCODE_CONFIG_CONTENT`; the
 * workspace configuration, agent, artifact, and MCP server are used unchanged,
 * and no hosted model is contacted. The first agent request is answered and the
 * child is stopped, so no later turn can mask a missing, delayed, duplicated,
 * or unknown tool. The request is asserted against the declared surface before
 * this function returns.
 *
 * @param input - Workspace, declared surface, executable, and optional timeout.
 * @returns The request-1 tools and the complete request ledger.
 * @throws {@link import('./requestSurface.ts').SurfaceReadinessError} When agent request 1 differs from the declaration.
 */
export const capturePresentedTools = async (
	input: Readonly<{
		workspace: string;
		surface: ToolSurfaceType;
		/** Configured MCP server name for the production readiness gate. */
		mcpServer?: string;
		/** Deterministic command seam; bypasses the private server gate. */
		command?: string;
		/** Executable for the readiness-gated private server and its client. */
		serverCommand?: string;
		/** Absolute paths that no provider request may disclose. */
		forbiddenRoots?: readonly string[];
		timeoutMs?: number;
	}>,
): Promise<CapturedSurfaceType> => {
	const workspace = path.resolve(input.workspace);
	const dataHome = mkdtempSync(path.join(tmpdir(), 'codeindex-surface-'));
	const state: ProbeStateType = {requests: [], forbiddenRoots: [...(input.forbiddenRoots ?? [])]};
	const {promise: settled, resolve: settle} = Promise.withResolvers<Error | null>();
	const {server, port} = await probeServerOf(state, settle);
	let child: ChildProcess | null = null;
	let invocation: ProbeInvocationType | null = null;

	try {
		invocation = await invocationOf(input, dataHome, port);

		let stderr = '';

		child = spawn(input.command ?? input.serverCommand ?? 'opencode', invocation.args, {
			cwd: workspace,
			env: invocation.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		});
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

		const ledger = assertRequestOneSurface(input.surface, state.requests);
		const {firstAgentRequest} = ledger;

		return {
			tools: firstAgentRequest?.toolNames ?? [],
			agentRequests: ledger.agentRequests,
			titleRequests: ledger.titleRequests,
			requests: state.requests,
			ledger,
			serverReadiness: invocation.serverReadiness,
		};
	} finally {
		if (child !== null) {
			await terminateProbeOf(child);
		}

		const openCode = invocation?.openCode ?? null;

		if (openCode !== null) {
			await openCode.close();
		}

		server.closeAllConnections();
		const closed = once(server, 'close');

		server.close();
		await closed;
		rmSync(dataHome, {recursive: true, force: true});
	}
};
