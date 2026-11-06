import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type CliResultType = Readonly<{
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}>;

type RunCommandInputType = Readonly<{
	command: string;
	args: readonly string[];
	cwd: string;
	environment: NodeJS.ProcessEnv;
	logPath: string;
	timeoutMs?: number;
	onLine?: (line: string) => void;
}>;

type CommandLogStateType = Readonly<{
	started: number;
	stdout: string;
	stderr: string;
	extra: string | null;
	exitCode: number | null;
}>;

const appendBounded = (current: string, chunk: string): string => (current.length >= MAX_LOG_BYTES ? current : (current + chunk).slice(0, MAX_LOG_BYTES));

const finalStderrOf = (stderr: string, extra: string | null): string =>
	extra === null ? stderr : `${stderr}${stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n'}${extra}`;

const persistCommandLog = (input: RunCommandInputType, state: CommandLogStateType): void => {
	writeFileSync(
		input.logPath,
		[
			`$ ${input.command} ${input.args.join(' ')}`,
			`cwd: ${input.cwd}`,
			`exit: ${state.exitCode === null ? 'running' : String(state.exitCode)}`,
			`duration: ${(performance.now() - state.started).toFixed(1)} ms`,
			'',
			'--- stdout ---',
			state.stdout,
			'--- stderr ---',
			finalStderrOf(state.stderr, state.extra),
			'',
		].join('\n'),
		{encoding: 'utf8'},
	);
};

const terminateChild = (child: ChildProcess, detached: boolean, signal: NodeJS.Signals): void => {
	if (child.pid === undefined) {
		return;
	}

	try {
		if (detached) {
			process.kill(-child.pid, signal);
		} else {
			child.kill(signal);
		}
	} catch {
		// The process may have exited between the deadline and signal delivery.
	}
};

/**
 * Runs one child process and persists a bounded log.
 *
 * Stderr lines are forwarded to the optional progress callback so a long step
 * can report scenario and edit-round progress while it runs. The child receives
 * a clean environment without inherited `CODE_INDEX_*` overrides, so every step
 * measures the same configuration.
 *
 * @param input - Command, working directory, environment, log path, and progress sink.
 * @returns Exit code, captured output, and duration.
 */
export const runCommand = async (input: RunCommandInputType): Promise<CliResultType> => {
	const started = performance.now();
	const detached = process.platform !== 'win32';
	mkdirSync(path.dirname(input.logPath), {recursive: true});
	const child = spawn(input.command, [...input.args], {
		cwd: input.cwd,
		env: input.environment,
		detached,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	let pending = '';
	let extra: string | null = null;
	let exitCode: number | null = null;

	const persistLog = (): void => {
		persistCommandLog(input, {started, stdout, stderr, extra, exitCode});
	};

	persistLog();

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout = appendBounded(stdout, chunk);
		persistLog();
	});
	child.stderr.on('data', (chunk: string) => {
		stderr = appendBounded(stderr, chunk);
		pending += chunk;
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';

		for (const line of lines) {
			input.onLine?.(line);
		}

		persistLog();
	});

	const timeout =
		input.timeoutMs === undefined
			? null
			: setTimeout(() => {
					extra = `Timed out after ${String(input.timeoutMs)} ms`;
					persistLog();
					terminateChild(child, detached, 'SIGTERM');
				}, input.timeoutMs);
	timeout?.unref();

	try {
		await once(child, 'close');
		exitCode = child.exitCode ?? 1;
	} catch (error) {
		extra ??= error instanceof Error ? error.message : String(error);
		exitCode = 1;
	} finally {
		if (timeout !== null) {
			clearTimeout(timeout);
		}
	}

	const durationMs = performance.now() - started;

	if (pending.length > 0) {
		input.onLine?.(pending);
	}

	const finalStderr = finalStderrOf(stderr, extra);
	persistLog();

	return {exitCode, stdout, stderr: finalStderr, durationMs};
};

/**
 * Removes inherited CodeIndex overrides and disables analytics.
 *
 * @param environment - Parent process environment.
 * @returns Environment for a measured child process.
 */
export const cleanChildEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
	const cleaned: NodeJS.ProcessEnv = {};

	for (const [name, value] of Object.entries(environment)) {
		if (!name.startsWith('CODE_INDEX_')) {
			cleaned[name] = value;
		}
	}

	return {...cleaned, CODE_INDEX_ANALYTICS: 'false', NO_COLOR: '1'};
};

const lastLines = (value: string, count: number): string => value.trimEnd().split('\n').slice(-count).join(' ');

/**
 * Extracts a single table-safe failure line from child diagnostics.
 *
 * Uncaught crashes end with a generic `Node.js v…` trailer; the first `Error:`
 * line carries the actual cause. Fall back to the trailing lines when no error
 * line is present.
 *
 * @param value - Diagnostic output.
 * @returns One sanitized line.
 */
export const failureDetail = (value: string): string => {
	const errorLine = value.split('\n').find((line) => line.startsWith('Error: '));
	const detail = errorLine ?? lastLines(value, 3);

	return detail.replaceAll('|', String.raw`\|`);
};
