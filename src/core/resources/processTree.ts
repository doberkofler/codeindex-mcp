import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {text} from 'node:stream/consumers';

const BYTES_PER_KILOBYTE = 1024;
const PS_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 200;

type ProcessRowType = Readonly<{pid: number; parentPid: number; rssBytes: number}>;

export type ProcessTreeSnapshotType = Readonly<{
	rssBytes: number;
	descendantCount: number;
}>;

type CacheEntryType = {
	snapshot: ProcessTreeSnapshotType;
	sampledAt: number;
	pending: boolean;
};

const cache = new Map<number, CacheEntryType>();

const rowsOf = (output: string): readonly ProcessRowType[] => {
	const rows: ProcessRowType[] = [];

	for (const line of output.split('\n')) {
		const [pid, parentPid, rss] = line.trim().split(/\s+/u);

		if (pid === undefined || parentPid === undefined || rss === undefined) {
			continue;
		}

		const parsedPid = Number(pid);
		const parsedParent = Number(parentPid);
		const parsedRss = Number(rss);

		if (Number.isInteger(parsedPid) && Number.isInteger(parsedParent) && Number.isFinite(parsedRss)) {
			rows.push({pid: parsedPid, parentPid: parsedParent, rssBytes: parsedRss * BYTES_PER_KILOBYTE});
		}
	}

	return rows;
};

const snapshotOf = (rows: readonly ProcessRowType[], rootPid: number): ProcessTreeSnapshotType => {
	const children = new Map<number, ProcessRowType[]>();
	const byPid = new Map<number, ProcessRowType>();

	for (const row of rows) {
		byPid.set(row.pid, row);
		const siblings = children.get(row.parentPid) ?? [];
		siblings.push(row);
		children.set(row.parentPid, siblings);
	}

	let rssBytes = 0;
	const pending = [rootPid];
	const visited = new Set<number>();

	while (pending.length > 0) {
		const pid = pending.pop();

		if (pid === undefined || visited.has(pid)) {
			continue;
		}

		visited.add(pid);
		rssBytes += byPid.get(pid)?.rssBytes ?? 0;

		for (const child of children.get(pid) ?? []) {
			pending.push(child.pid);
		}
	}

	return {
		rssBytes: rssBytes === 0 ? process.memoryUsage().rss : rssBytes,
		descendantCount: Math.max(0, visited.size - 1),
	};
};

const readRows = async (): Promise<readonly ProcessRowType[]> => {
	if (process.platform === 'win32') {
		return [];
	}

	try {
		const child = spawn('ps', ['-A', '-o', 'pid=,ppid=,rss='], {
			stdio: ['ignore', 'pipe', 'ignore'],
			signal: AbortSignal.timeout(PS_TIMEOUT_MS),
		});
		const output = text(child.stdout);
		await once(child, 'close');
		return rowsOf(await output);
	} catch {
		return [];
	}
};

const refresh = async (rootPid: number, entry: CacheEntryType): Promise<void> => {
	if (entry.pending) {
		return;
	}

	entry.pending = true;
	try {
		const rows = await readRows();
		entry.snapshot = rows.length === 0 ? {rssBytes: process.memoryUsage().rss, descendantCount: 0} : snapshotOf(rows, rootPid);
		entry.sampledAt = performance.now();
	} finally {
		entry.pending = false;
	}
};

/**
 * Returns the latest non-blocking process-tree sample and schedules refresh.
 *
 * The first call falls back to current-process RSS while asynchronous `ps`
 * sampling runs. No process-tree command executes synchronously on the caller's
 * event-loop turn.
 *
 * @param rootPid - Root process; defaults to the current process.
 * @returns Cached resident bytes and descendant count.
 */
export const processTreeSnapshot = (rootPid: number = process.pid): ProcessTreeSnapshotType => {
	const now = performance.now();
	const existing = cache.get(rootPid);
	const entry =
		existing ??
		({
			snapshot: {rssBytes: process.memoryUsage().rss, descendantCount: 0},
			sampledAt: Number.NEGATIVE_INFINITY,
			pending: false,
		} satisfies CacheEntryType);

	if (existing === undefined) {
		cache.set(rootPid, entry);
	}

	if (now - entry.sampledAt >= CACHE_TTL_MS) {
		void refresh(rootPid, entry);
	}

	return entry.snapshot;
};

/**
 * Returns cached process-tree RSS without blocking the event loop.
 *
 * @param rootPid - Root process; defaults to the current process.
 * @returns Cached resident bytes.
 */
export const processTreeRssBytes = (rootPid: number = process.pid): number => processTreeSnapshot(rootPid).rssBytes;
