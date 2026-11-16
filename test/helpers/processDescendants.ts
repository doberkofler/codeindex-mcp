import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {text} from 'node:stream/consumers';
import {setTimeout as delay} from 'node:timers/promises';

const EXIT_TIMEOUT_MS = 2000;
const POLL_MS = 20;

type ProcessRowType = Readonly<{pid: number; parentPid: number}>;

const processRows = async (): Promise<readonly ProcessRowType[]> => {
	const child = spawn('ps', ['-A', '-o', 'pid=,ppid='], {stdio: ['ignore', 'pipe', 'ignore']});
	const output = text(child.stdout);
	await once(child, 'close');
	const source = await output;
	return source
		.split('\n')
		.map((line) => line.trim().split(/\s+/u).map(Number))
		.flatMap(([pid = Number.NaN, parentPid = Number.NaN]) => (Number.isInteger(pid) && Number.isInteger(parentPid) ? [{pid, parentPid}] : []));
};

/**
 * @param rootPid - Process whose descendants are requested.
 * @returns Every current descendant PID.
 */
export const descendantPidsOf = async (rootPid: number): Promise<readonly number[]> => {
	const rows = await processRows();
	const children = new Map<number, number[]>();

	for (const row of rows) {
		children.set(row.parentPid, [...(children.get(row.parentPid) ?? []), row.pid]);
	}

	const pending = [...(children.get(rootPid) ?? [])];
	const descendants = new Set<number>();

	while (pending.length > 0) {
		const pid = pending.pop();

		if (pid === undefined || descendants.has(pid)) {
			continue;
		}

		descendants.add(pid);
		pending.push(...(children.get(pid) ?? []));
	}

	return [...descendants];
};

/**
 * Waits until previously observed descendant PIDs, including zombies, disappear.
 *
 * @param pids - Descendants observed before owner shutdown.
 * @param startedAt - Original wait start for recursive polling.
 * @returns Completion after every descendant disappears.
 */
export const waitForProcessExit = async (pids: readonly number[], startedAt = performance.now()): Promise<void> => {
	const rows = await processRows();
	const live = new Set(rows.map((row) => row.pid));

	if (pids.every((pid) => !live.has(pid))) {
		return;
	}

	if (performance.now() - startedAt >= EXIT_TIMEOUT_MS) {
		throw new Error('Compiler descendants remained after shutdown');
	}

	await delay(POLL_MS);
	return waitForProcessExit(pids, startedAt);
};
