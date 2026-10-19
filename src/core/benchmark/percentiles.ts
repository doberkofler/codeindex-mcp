import {type BenchmarkPercentilesType} from './benchTypes.ts';

/**
 * Returns the nearest-rank percentile of a sample.
 *
 * @param values - Observed values.
 * @param fraction - Percentile fraction between 0 and 1.
 * @returns The rounded percentile, or null for an empty sample.
 */
const percentile = (values: readonly number[], fraction: number): number | null => {
	if (values.length === 0) {
		return null;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return Math.round(sorted[index] ?? 0);
};

/**
 * Summarizes one latency sample.
 *
 * @param values - Observed milliseconds.
 * @returns Count, p50, p95, p99, and maximum.
 */
export const summarize = (values: readonly number[]): BenchmarkPercentilesType => ({
	count: values.length,
	p50Ms: percentile(values, 0.5),
	p95Ms: percentile(values, 0.95),
	p99Ms: percentile(values, 0.99),
	maxMs: values.length === 0 ? null : Math.max(...values),
});

/**
 * Measures one synchronous action in milliseconds.
 *
 * @param action - Work to run.
 * @returns Elapsed milliseconds.
 */
export const measure = (action: () => void): number => {
	const startedAt = performance.now();
	action();
	return performance.now() - startedAt;
};
