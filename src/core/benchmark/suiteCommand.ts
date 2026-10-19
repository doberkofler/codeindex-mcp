import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type CliResultType = Readonly<{
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}>;

/**
 * Runs one child process and persists a bounded log.
 *
 * The child receives a clean environment without inherited `CODE_INDEX_*`
 * overrides, so every step measures the same configuration.
 *
 * @param input - Command, working directory, environment, and log path.
 * @returns Exit code, captured output, and duration.
 */
export const runCommand = (
	input: Readonly<{
		command: string;
		args: readonly string[];
		cwd: string;
		environment: NodeJS.ProcessEnv;
		logPath: string;
	}>,
): CliResultType => {
	const started = performance.now();
	const result = spawnSync(input.command, [...input.args], {
		cwd: input.cwd,
		env: input.environment,
		encoding: 'utf8',
		maxBuffer: MAX_LOG_BYTES,
	});
	const durationMs = performance.now() - started;
	const {stdout} = result;
	const stderr = result.error === undefined ? result.stderr : `${result.stderr}\n${result.error.message}`;
	const {status} = result;
	const cliResult = {
		exitCode: status ?? 1,
		stdout,
		stderr,
		durationMs,
	};

	mkdirSync(path.dirname(input.logPath), {recursive: true});
	writeFileSync(
		input.logPath,
		[
			`$ ${input.command} ${input.args.join(' ')}`,
			`cwd: ${input.cwd}`,
			`exit: ${String(cliResult.exitCode)}`,
			`duration: ${durationMs.toFixed(1)} ms`,
			'',
			'--- stdout ---',
			stdout,
			'--- stderr ---',
			stderr,
			'',
		].join('\n'),
		{encoding: 'utf8'},
	);

	return cliResult;
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
