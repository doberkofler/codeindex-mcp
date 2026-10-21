import {spawn, type ChildProcess} from 'node:child_process';
import {assertionOf, resultOf, type AssertionType, type CheckResultType} from './assertions.ts';
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

const OUTPUT_TAIL = 4_000;
const TERMINATE_GRACE_MS = 2_000;
const HARD_CLOSE_GRACE_MS = 5_000;

/**
 * Signals the post-run process group, falling back to the direct child.
 *
 * @param child - Spawned command.
 * @param signal - Signal to deliver.
 */
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
	if (child.pid === undefined) {
		return;
	}

	if (process.platform === 'win32') {
		child.kill(signal);

		return;
	}

	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
};

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
	const reason =
		input.error !== null
			? input.error
			: input.timedOut
				? `post-run command timed out after ${check.timeoutMs} ms`
				: input.exitCode === check.expectedExitCode
					? 'post-run command matched the expected exit code'
					: `post-run command exited ${input.exitCode ?? 'without a status'}, expected ${check.expectedExitCode}`;

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
	let stdout = '';
	let stderr = '';
	let timedOut = false;
	let spawnError: string | null = null;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let escalationTimer: NodeJS.Timeout | undefined;
	let hardCloseTimer: NodeJS.Timeout | undefined;

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});

	const exit = await new Promise<Readonly<{code: number | null; signal: NodeJS.Signals | null}>>((resolve) => {
		let settled = false;

		const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(escalationTimer);
			clearTimeout(hardCloseTimer);
			resolve({code, signal});
		};

		child.on('close', (code, signal) => {
			finish(code, signal);
		});
		child.on('error', (error: Error) => {
			spawnError = error.message;
			finish(null, null);
		});

		timeoutTimer = setTimeout(() => {
			timedOut = true;
			signalGroup(child, 'SIGTERM');
			escalationTimer = setTimeout(() => {
				signalGroup(child, 'SIGKILL');
			}, TERMINATE_GRACE_MS);
		}, check.timeoutMs);

		hardCloseTimer = setTimeout(
			() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.unref();
				finish(null, 'SIGKILL');
			},
			check.timeoutMs + TERMINATE_GRACE_MS + HARD_CLOSE_GRACE_MS,
		);
	});

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
