import {statSync} from 'node:fs';
import {type IndexDatabase} from '../storage/database.ts';
import {type BenchmarkResourceType, type BenchmarkStorageType} from './benchTypes.ts';

const RSS_SAMPLE_INTERVAL_MS = 25;
const BYTES_PER_KILOBYTE = 1024;

export type ResourceSamplerType = Readonly<{
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
	let rssPeak = rssStart;
	const timer = setInterval(() => {
		rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
	}, RSS_SAMPLE_INTERVAL_MS);

	timer.unref();

	return {
		stop: () => {
			clearInterval(timer);
			const cpu = process.cpuUsage(cpuStart);
			const rssEnd = process.memoryUsage().rss;
			const usage = process.resourceUsage();

			return {
				cpuUserMs: Math.round(cpu.user / 1000),
				cpuSystemMs: Math.round(cpu.system / 1000),
				rssStartBytes: rssStart,
				rssPeakBytes: Math.max(rssPeak, rssEnd),
				rssEndBytes: rssEnd,
				lifetimeMaxRssBytes: usage.maxRSS * BYTES_PER_KILOBYTE,
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
