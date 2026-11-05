import {processTreeRssBytes} from './processTree.ts';

const RSS_SAMPLE_INTERVAL_MS = 25;
const TREE_RSS_SAMPLE_INTERVAL_MS = 250;

type ProcessSampleType = Readonly<{
	readonly cpuUserMs: number;
	readonly cpuSystemMs: number;
	readonly rssStartBytes: number;
	readonly rssPeakBytes: number;
	readonly rssEndBytes: number;
	readonly processTreeRssStartBytes: number;
	readonly processTreeRssPeakBytes: number;
	readonly processTreeRssEndBytes: number;
}>;

export type ProcessSamplerType = Readonly<{
	stop: () => ProcessSampleType;
}>;

/**
 * Samples process-wide CPU and resident memory, including child processes.
 *
 * Worker threads share the process, so `rss` includes build workers. The tree
 * sample also includes compiler child processes, which is the cost that a
 * persistent worker keeps alive between refreshes.
 *
 * @returns A sampler that reports deltas when stopped.
 */
export const startProcessSample = (): ProcessSamplerType => {
	const cpuStart = process.cpuUsage();
	const rssStart = process.memoryUsage().rss;
	const treeStart = processTreeRssBytes();
	let rssPeak = rssStart;
	let treePeak = treeStart;
	const timer = setInterval(() => {
		rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
	}, RSS_SAMPLE_INTERVAL_MS);
	const treeTimer = setInterval(() => {
		treePeak = Math.max(treePeak, processTreeRssBytes());
	}, TREE_RSS_SAMPLE_INTERVAL_MS);

	timer.unref();
	treeTimer.unref();

	return {
		stop: () => {
			clearInterval(timer);
			clearInterval(treeTimer);
			const cpu = process.cpuUsage(cpuStart);
			const rssEnd = process.memoryUsage().rss;
			const treeEnd = processTreeRssBytes();

			return {
				cpuUserMs: Math.round(cpu.user / 1000),
				cpuSystemMs: Math.round(cpu.system / 1000),
				rssStartBytes: rssStart,
				rssPeakBytes: Math.max(rssPeak, rssEnd),
				rssEndBytes: rssEnd,
				processTreeRssStartBytes: treeStart,
				processTreeRssPeakBytes: Math.max(treePeak, treeEnd),
				processTreeRssEndBytes: treeEnd,
			};
		},
	};
};
