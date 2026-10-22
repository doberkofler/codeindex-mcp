import {spawn} from 'node:child_process';
import {assertionOf, resultOf, type AssertionType, type CheckResultType} from './assertions.ts';
import {runChildOf} from './childProcess.ts';
import {type PostRunCheckType} from './schema.ts';

/** Deterministic post-run command result, independent of answer and workflow. */
export type PostRunResultType = Readonly<{
	result: CheckResultType;
	command: string;
	args: readonly string[];
	expectedExitCode: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	durationMs: number;
	stdoutTail: string;
	stderrTail: string;
	error: string | null;
	reason: string;
	assertions: readonly AssertionType[];
}>;

const OUTPUT_TAIL = 4000;

const assertionsOf = (check: PostRunCheckType, exitCode: number | null, timedOut: boolean, error: string | null): readonly AssertionType[] => [
	assertionOf({
		id: 'post-run.completed',
		kind: 'post-run',
		expected: {timedOut: false, error: null},
		observed: {timedOut, error},
		result: !timedOut && error === null ? 'pass' : 'fail',
	}),
	assertionOf({
		id: 'post-run.exit-code',
		kind: 'post-run',
		expected: check.expectedExitCode,
		observed: exitCode,
		result: !timedOut && error === null && exitCode === check.expectedExitCode ? 'pass' : 'fail',
	}),
];

const resultWith = (
	check: PostRunCheckType,
	input: Readonly<{
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
		durationMs: number;
		stdout: string;
		stderr: string;
		error: string | null;
	}>,
): PostRunResultType => {
	const assertions = assertionsOf(check, input.exitCode, input.timedOut, input.error);
	const result = resultOf(assertions);
	const exitReason = input.timedOut
		? `post-run command timed out after ${check.timeoutMs} ms`
		: input.exitCode === check.expectedExitCode
			? 'post-run command matched the expected exit code'
			: `post-run command exited ${input.exitCode ?? 'without a status'}, expected ${check.expectedExitCode}`;
	const reason = input.error ?? exitReason;

	return {
		result,
		command: check.command,
		args: check.args,
		expectedExitCode: check.expectedExitCode,
		exitCode: input.exitCode,
		signal: input.signal,
		timedOut: input.timedOut,
		durationMs: input.durationMs,
		stdoutTail: input.stdout.slice(-OUTPUT_TAIL),
		stderrTail: input.stderr.slice(-OUTPUT_TAIL),
		error: input.error,
		reason,
		assertions,
	};
};

/**
 * Marks a declared post-run command that was not executed.
 *
 * @param check - Declared command.
 * @param reason - Why no observation exists.
 * @returns An explicit unevaluated result, never a pass.
 */
export const skippedPostRunOf = (check: PostRunCheckType, reason: string): PostRunResultType => {
	const assertions = [
		assertionOf({
			id: 'post-run.executed',
			kind: 'post-run',
			expected: true,
			observed: false,
			result: 'unevaluated',
		}),
	];

	return {
		result: resultOf(assertions),
		command: check.command,
		args: check.args,
		expectedExitCode: check.expectedExitCode,
		exitCode: null,
		signal: null,
		timedOut: false,
		durationMs: 0,
		stdoutTail: '',
		stderrTail: '',
		error: reason,
		reason,
		assertions,
	};
};

/**
 * Executes one declared post-run command in the workspace.
 *
 * The command is spawned without a shell, with a hard timeout and a separate
 * process group, so a descendant cannot keep the harness alive. Output is
 * bounded; the command's mutation is removed by workspace restoration.
 *
 * @param check - Declared command.
 * @param cwd - Workspace directory.
 * @returns The command outcome and its assertions.
 */
export const postRunOf = async (check: PostRunCheckType, cwd: string): Promise<PostRunResultType> => {
	const started = Date.now();
	const child = spawn(check.command, check.args, {
		cwd,
		shell: false,
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const run = await runChildOf({child, timeoutMs: check.timeoutMs});
	const {stdout, stderr, timedOut, spawnError, exit} = run;

	return resultWith(check, {
		exitCode: exit.code,
		signal: exit.signal,
		timedOut,
		durationMs: Date.now() - started,
		stdout,
		stderr,
		error: spawnError,
	});
};
