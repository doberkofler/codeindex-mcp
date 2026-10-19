import {spawn} from 'node:child_process';
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

const appendBounded = (current: string, chunk: string): string => (current.length >= MAX_LOG_BYTES ? current : (current + chunk).slice(0, MAX_LOG_BYTES));

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
export const runCommand = async (
	input: Readonly<{
		command: string;
		args: readonly string[];
		cwd: string;
		environment: NodeJS.ProcessEnv;
		logPath: string;
		onLine?: (line: string) => void;
	}>,
): Promise<CliResultType> => {
	const started = performance.now();
	const child = spawn(input.command, [...input.args], {
		cwd: input.cwd,
		env: input.environment,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	let pending = '';

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout = appendBounded(stdout, chunk);
	});
	child.stderr.on('data', (chunk: string) => {
		stderr = appendBounded(stderr, chunk);
		pending += chunk;
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';

		for (const line of lines) {
			input.onLine?.(line);
		}
	});

	let exitCode = 1;
	let extra: string | null = null;

	try {
		await once(child, 'close');
		exitCode = child.exitCode ?? 1;
	} catch (error) {
		extra = error instanceof Error ? error.message : String(error);
	}

	const durationMs = performance.now() - started;

	if (pending.length > 0) {
		input.onLine?.(pending);
	}

	const finalStderr = extra === null ? stderr : `${stderr}\n${extra}`;

	mkdirSync(path.dirname(input.logPath), {recursive: true});
	writeFileSync(
		input.logPath,
		[
			`$ ${input.command} ${input.args.join(' ')}`,
			`cwd: ${input.cwd}`,
			`exit: ${String(exitCode)}`,
			`duration: ${durationMs.toFixed(1)} ms`,
			'',
			'--- stdout ---',
			stdout,
			'--- stderr ---',
			finalStderr,
			'',
		].join('\n'),
		{encoding: 'utf8'},
	);

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
