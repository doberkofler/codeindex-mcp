import {spawn, type ChildProcess} from 'node:child_process';
import {type ClientStoreType} from './isolation.ts';
import {type OpenCodeServerType} from './opencodeServer.ts';
import {isolatedProcessEnvironmentOf} from './processEnvironment.ts';

/** Default executable; tests replace it with a controlled agent script. */
const AGENT_COMMAND = 'opencode';

/**
 * Builds the isolated environment shared by the private server and its client.
 *
 * OpenCode resolves the project from PWD, which spawn does not update.
 * OPENCODE_DB is always explicit; an inherited value is never reused.
 *
 * @param input - Workspace and client store.
 * @returns Environment for the server and the `run` client.
 */
export const agentEnvironmentOf = (input: Readonly<{cwd: string; clientStore: ClientStoreType}>): NodeJS.ProcessEnv =>
	isolatedProcessEnvironmentOf({
		PWD: input.cwd,
		OPENCODE_DB: input.clientStore.opencodeDb,
		OPENCODE_DISABLE_TELEMETRY: '1',
	});

/**
 * Starts one model process against a ready server or a private standalone server.
 *
 * A non-null server has already reported its expected MCP servers connected, so
 * the prompt cannot be composed before the treatment surface exists.
 *
 * @param input - Workspace, model, client store, optional command, and ready server.
 * @param prompt - Evaluation prompt.
 * @param server - Ready private server, or null for the deterministic command seam.
 * @returns The spawned agent process.
 */
export const agentProcessOf = (
	input: Readonly<{cwd: string; model: string; clientStore: ClientStoreType; command?: string}>,
	prompt: string,
	server: OpenCodeServerType | null,
): ChildProcess => {
	const environment = agentEnvironmentOf(input);
	const connection = server === null ? ['--standalone'] : ['--server', server.url];

	if (server !== null) {
		environment['OPENCODE_SERVER_PASSWORD'] = server.password;
	}

	return spawn(input.command ?? AGENT_COMMAND, ['run', ...connection, '--agent', 'evaluator', '--model', input.model, '--format', 'json', '--auto', prompt], {
		cwd: input.cwd,
		// A new process group lets the timeout reach the private server and
		// every tool subprocess. The group is never the harness's own.
		detached: process.platform !== 'win32',
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
};
