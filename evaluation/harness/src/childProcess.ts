import {type ChildProcess} from 'node:child_process';

/** Exit code and terminating signal of one finished child. */
export type ChildExitType = Readonly<{code: number | null; signal: NodeJS.Signals | null}>;

/** Captured output and outcome of one child execution. */
export type ChildRunType = Readonly<{
	exit: ChildExitType;
	/** True when the timeout fired before the child exited on its own. */
	timedOut: boolean;
	stdout: string;
	stderr: string;
	/** Spawn failure message, or null when the process started. */
	spawnError: string | null;
}>;

/** Milliseconds a terminated child gets before SIGKILL. */
export const TERMINATE_GRACE_MS = 2000;

/** Milliseconds granted to a descendant that still holds the pipes open. */
export const HARD_CLOSE_GRACE_MS = 5000;

/**
 * Delivers one signal to a child and every process it started.
 *
 * A detached child owns its process group, so signalling the group also reaches
 * tool subprocesses. Without a pid, or on Windows where groups differ, the child
 * itself is signalled.
 *
 * @param child - Spawned process.
 * @param signal - Signal to deliver.
 */
export const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
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

/**
 * Runs one child to completion and captures its output.
 *
 * The timeout escalates from SIGTERM to SIGKILL inside the child's process
 * group. A descendant that escaped the group can hold the pipes open, so the
 * wait is bounded: after the hard-close grace the streams are destroyed and the
 * captured output is returned as the result.
 *
 * @param input - Child, timeout, and grace periods.
 * @returns Exit facts, timeout flag, captured output, and spawn error.
 */
export const runChildOf = async (
	input: Readonly<{child: ChildProcess; timeoutMs: number; terminateGraceMs?: number; hardCloseGraceMs?: number}>,
): Promise<ChildRunType> => {
	const {child} = input;
	const terminateGraceMs = input.terminateGraceMs ?? TERMINATE_GRACE_MS;
	const hardCloseGraceMs = input.hardCloseGraceMs ?? HARD_CLOSE_GRACE_MS;
	const {promise: exitSettled, resolve: resolveExit} = Promise.withResolvers<ChildExitType>();
	let stdout = '';
	let stderr = '';
	let timedOut = false;
	let spawnError: string | null = null;
	let settled = false;
	const timers: {timeout?: NodeJS.Timeout; escalation?: NodeJS.Timeout; hardClose?: NodeJS.Timeout} = {};

	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on('data', (chunk: string) => {
		stderr += chunk;
	});

	const finish = (exit: ChildExitType): void => {
		if (settled) {
			return;
		}

		settled = true;
		clearTimeout(timers.timeout);
		clearTimeout(timers.escalation);
		clearTimeout(timers.hardClose);
		resolveExit(exit);
	};

	child.on('close', (code, signal) => {
		finish({code, signal});
	});
	child.on('error', (error: Error) => {
		spawnError = error.message;
		finish({code: null, signal: null});
	});

	timers.timeout = setTimeout(() => {
		timedOut = true;
		signalGroup(child, 'SIGTERM');
		timers.escalation = setTimeout(() => {
			signalGroup(child, 'SIGKILL');
		}, terminateGraceMs);
	}, input.timeoutMs);

	timers.hardClose = setTimeout(
		() => {
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
			finish({code: null, signal: 'SIGKILL'});
		},
		input.timeoutMs + terminateGraceMs + hardCloseGraceMs,
	);

	const exit = await exitSettled;

	return {exit, timedOut, stdout, stderr, spawnError};
};
