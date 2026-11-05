import {execFileSync} from 'node:child_process';

const BYTES_PER_KILOBYTE = 1024;
const PS_TIMEOUT_MS = 2000;

type ProcessRowType = Readonly<{pid: number; parentPid: number; rssBytes: number}>;

const rowsOf = (): readonly ProcessRowType[] => {
	if (process.platform === 'win32') {
		return [];
	}

	try {
		const output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], {encoding: 'utf8', timeout: PS_TIMEOUT_MS});
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
	} catch {
		return [];
	}
};

/**
 * Sums resident memory for one process and every descendant.
 *
 * Worker threads live in the parent process, while a compiler adapter's child
 * process is a descendant. Sampling this tree therefore reports the build
 * worker and every compiler it started. Unsupported platforms fall back to the
 * current process heap.
 *
 * @param rootPid - Root process; defaults to the current process.
 * @returns Total resident bytes, or the current process RSS when unsupported.
 */
export const processTreeRssBytes = (rootPid: number = process.pid): number => {
	const rows = rowsOf();

	if (rows.length === 0) {
		return process.memoryUsage().rss;
	}

	const children = new Map<number, ProcessRowType[]>();
	const byPid = new Map<number, ProcessRowType>();

	for (const row of rows) {
		byPid.set(row.pid, row);
		const siblings = children.get(row.parentPid) ?? [];
		siblings.push(row);
		children.set(row.parentPid, siblings);
	}

	let total = 0;
	const pending = [rootPid];
	const visited = new Set<number>();

	while (pending.length > 0) {
		const pid = pending.pop();

		if (pid === undefined || visited.has(pid)) {
			continue;
		}

		visited.add(pid);
		total += byPid.get(pid)?.rssBytes ?? 0;

		for (const child of children.get(pid) ?? []) {
			pending.push(child.pid);
		}
	}

	return total === 0 ? process.memoryUsage().rss : total;
};
