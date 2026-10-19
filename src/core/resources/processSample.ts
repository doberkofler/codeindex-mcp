const RSS_SAMPLE_INTERVAL_MS = 25;

type ProcessSampleType = Readonly<{
	readonly cpuUserMs: number;
	readonly cpuSystemMs: number;
	readonly rssStartBytes: number;
	readonly rssPeakBytes: number;
	readonly rssEndBytes: number;
}>;

export type ProcessSamplerType = Readonly<{
	stop: () => ProcessSampleType;
}>;

/**
 * Samples process-wide CPU and resident memory.
 *
 * Worker threads share the process, so the values include build workers but not
 * child processes.
 *
 * @returns A sampler that reports deltas when stopped.
 */
export const startProcessSample = (): ProcessSamplerType => {
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

			return {
				cpuUserMs: Math.round(cpu.user / 1000),
				cpuSystemMs: Math.round(cpu.system / 1000),
				rssStartBytes: rssStart,
				rssPeakBytes: Math.max(rssPeak, rssEnd),
				rssEndBytes: rssEnd,
			};
		},
	};
};
