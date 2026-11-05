import {statSync} from 'node:fs';
import {type IndexDatabase} from '../storage/database.ts';
import {processTreeRssBytes} from '../resources/processTree.ts';
import {type BenchmarkResourceType, type BenchmarkStorageType} from './benchTypes.ts';

const RSS_SAMPLE_INTERVAL_MS = 25;
const TREE_RSS_SAMPLE_INTERVAL_MS = 250;
const BYTES_PER_KILOBYTE = 1024;

export type ResourceSamplerType = Readonly<{
	/** Stops RSS polling without ending the CPU and peak-RSS measurement. */
	pause: () => void;
	/** Resumes RSS polling after {@link pause}. */
	resume: () => void;
	stop: () => BenchmarkResourceType;
}>;

const bytesOf = (filePath: string): number => {
	try {
		return statSync(filePath).size;
	} catch {
		return 0;
	}
};

/**
 * Samples process-wide CPU and resident memory for one scenario.
 *
 * Worker threads share the process, so `rss` and `cpuUsage` include the build
 * worker. Every scenario remains in one process; run separate invocations when
 * process-cold numbers are required.
 *
 * @returns A sampler that reports deltas when stopped.
 */
export const startResourceSampler = (): ResourceSamplerType => {
	const cpuStart = process.cpuUsage();
	const rssStart = process.memoryUsage().rss;
	const treeStart = processTreeRssBytes();
	let rssPeak = rssStart;
	let treePeak = treeStart;
	let timer: ReturnType<typeof setInterval> | null = null;
	let treeTimer: ReturnType<typeof setInterval> | null = null;
	const sample = (): void => {
		rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
	};

	// The poll itself costs CPU: reading resident memory is a syscall. A caller
	// that measures an idle process must suspend polling or it measures itself.
	const resume = (): void => {
		if (timer !== null) {
			return;
		}

		sample();
		timer = setInterval(sample, RSS_SAMPLE_INTERVAL_MS);
		timer.unref();
		treeTimer = setInterval(() => {
			treePeak = Math.max(treePeak, processTreeRssBytes());
		}, TREE_RSS_SAMPLE_INTERVAL_MS);
		treeTimer.unref();
	};
	const pause = (): void => {
		if (timer === null) {
			return;
		}

		clearInterval(timer);
		timer = null;

		if (treeTimer !== null) {
			clearInterval(treeTimer);
			treeTimer = null;
		}
	};

	resume();

	return {
		pause,
		resume,
		stop: () => {
			pause();
			const cpu = process.cpuUsage(cpuStart);
			const rssEnd = process.memoryUsage().rss;
			const treeEnd = processTreeRssBytes();
			const usage = process.resourceUsage();

			return {
				cpuUserMs: Math.round(cpu.user / 1000),
				cpuSystemMs: Math.round(cpu.system / 1000),
				rssStartBytes: rssStart,
				rssPeakBytes: Math.max(rssPeak, rssEnd),
				rssEndBytes: rssEnd,
				lifetimeMaxRssBytes: usage.maxRSS * BYTES_PER_KILOBYTE,
				processTreeRssStartBytes: treeStart,
				processTreeRssPeakBytes: Math.max(treePeak, treeEnd),
				processTreeRssEndBytes: treeEnd,
			};
		},
	};
};

/**
 * Reads the retained database footprint and row counts.
 *
 * SQLite reports logical pages; WAL and shared-memory files are measured
 * separately so the result reflects the on-disk cost at the sample point.
 *
 * @param database - Open index database.
 * @param databasePath - Database main file.
 * @returns Storage metrics.
 */
export const readStorage = (database: IndexDatabase, databasePath: string): BenchmarkStorageType => {
	const databaseBytes = database.databaseSizeBytes();
	const walBytes = bytesOf(`${databasePath}-wal`);
	const shmBytes = bytesOf(`${databasePath}-shm`);
	const extractionArtifacts = database.extractionArtifactCount();

	return {
		databaseBytes,
		walBytes,
		shmBytes,
		totalBytes: databaseBytes + walBytes + shmBytes,
		contentVersions: database.contentVersionCount(),
		extractionArtifacts,
	};
};
