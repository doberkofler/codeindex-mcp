import {monitorEventLoopDelay} from 'node:perf_hooks';

const PROBE_INTERVAL_MS = 10;

const percentile = (samples: readonly number[], ratio: number): number => {
	if (samples.length === 0) {
		return 0;
	}

	const sorted = [...samples].sort((left, right) => left - right);
	const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
	return sorted[index] ?? 0;
};

/**
 * Starts main-event-loop delay and scheduled-probe measurement.
 *
 * @returns Idempotent stop operation yielding bounded latency metrics.
 */
export const startEventLoopSample = (): Readonly<{stop: () => Readonly<Record<string, number>>}> => {
	const histogram = monitorEventLoopDelay({resolution: PROBE_INTERVAL_MS});
	const delays: number[] = [];
	let expectedAt = performance.now() + PROBE_INTERVAL_MS;
	histogram.enable();
	const timer = setInterval(() => {
		const now = performance.now();
		delays.push(Math.max(0, now - expectedAt));
		expectedAt = now + PROBE_INTERVAL_MS;
	}, PROBE_INTERVAL_MS);
	timer.unref();
	let result: Readonly<Record<string, number>> | null = null;

	return {
		stop: () => {
			if (result !== null) {
				return result;
			}

			clearInterval(timer);
			histogram.disable();
			result = {
				mainEventLoopP99Ms: Math.round((histogram.percentile(99) / 1_000_000) * 100) / 100,
				mainScheduledProbeP95Ms: Math.round(percentile(delays, 0.95) * 100) / 100,
				mainScheduledProbeP99Ms: Math.round(percentile(delays, 0.99) * 100) / 100,
				mainScheduledProbeCount: delays.length,
			};
			return result;
		},
	};
};
