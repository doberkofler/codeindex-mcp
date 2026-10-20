import {type ExtractedOccurrenceType} from '../../facts/index.ts';
import {type DistributionType} from './types.ts';

const sortedValues = (values: readonly number[]): readonly number[] => [...values].sort((left, right) => left - right);

const percentile = (values: readonly number[], point: number): number => {
	const sorted = sortedValues(values);

	if (sorted.length === 0) {
		return 0;
	}

	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((point / 100) * sorted.length) - 1));

	return sorted[rank] ?? 0;
};

const bucketOf = (value: number): string => {
	if (value <= 0) {
		return '0';
	}

	if (value === 1) {
		return '1';
	}

	if (value === 2) {
		return '2';
	}

	if (value <= 4) {
		return '3-4';
	}

	if (value <= 8) {
		return '5-8';
	}

	if (value <= 16) {
		return '9-16';
	}

	return '17+';
};

/**
 * Counts values by a stable string key.
 *
 * @param values - Values to count.
 * @returns Counts keyed by value.
 */
export const countBy = (values: readonly string[]): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {};

	for (const value of values) {
		counts[value] = (counts[value] ?? 0) + 1;
	}

	return counts;
};

/**
 * Builds the bounded distribution used by Phase 2 measurements.
 *
 * @param values - Non-negative values.
 * @returns Count, fixed buckets, percentiles, and maximum.
 */
export const distributionOf = (values: readonly number[]): DistributionType => ({
	total: values.length,
	buckets: countBy(values.map((value) => bucketOf(value))),
	p50: percentile(values, 50),
	p95: percentile(values, 95),
	p99: percentile(values, 99),
	max: sortedValues(values).at(-1) ?? 0,
});

/**
 * Returns a distribution percentile using nearest-rank selection.
 *
 * @param values - Non-negative values.
 * @param point - Percentile in the inclusive range 0-100.
 * @returns Selected value, or zero for an empty input.
 */
export const percentileOf = (values: readonly number[], point: number): number => percentile(values, point);

/**
 * Counts distinct source lines represented by occurrence ranges.
 *
 * @param occurrences - Stored occurrences.
 * @returns Number of distinct represented source lines.
 */
export const sourceLinesRepresented = (occurrences: readonly ExtractedOccurrenceType[]): number => {
	const intervalsByPath = new Map<string, [number, number][]>();

	for (const occurrence of occurrences) {
		const intervals = intervalsByPath.get(occurrence.path) ?? [];
		const start = Math.min(occurrence.startLine, occurrence.endLine);
		const end = Math.max(occurrence.startLine, occurrence.endLine);
		intervals.push([start, end]);
		intervalsByPath.set(occurrence.path, intervals);
	}

	let total = 0;

	for (const intervals of intervalsByPath.values()) {
		const sorted = intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
		let currentStart = -1;
		let currentEnd = -1;

		for (const [start, end] of sorted) {
			if (currentStart === -1) {
				currentStart = start;
				currentEnd = end;
				continue;
			}

			if (start <= currentEnd + 1) {
				currentEnd = Math.max(currentEnd, end);
				continue;
			}

			total += currentEnd - currentStart + 1;
			currentStart = start;
			currentEnd = end;
		}

		if (currentStart !== -1) {
			total += currentEnd - currentStart + 1;
		}
	}

	return total;
};
