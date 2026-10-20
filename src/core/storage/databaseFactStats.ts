import {type FinalizedBindingType, type FinalizedFactSetType, type FinalizedSymbolType} from '../facts/types.ts';

/** One persisted closed-category build statistic row. */
export type BuildStatRowType = Readonly<{
	readonly language: string;
	readonly metric: string;
	readonly dim1: string;
	readonly dim2: string;
	readonly dim3: string;
	readonly value: number;
}>;

const BOUNDED_STAT_CATEGORY = /^[a-z][a-z0-9_-]{0,127}$/u;

const statKey = (row: BuildStatRowType): string => [row.language, row.metric, row.dim1, row.dim2, row.dim3].join('\u0000');

const boundedCategory = (value: string, name: string): string => {
	if (!BOUNDED_STAT_CATEGORY.test(value)) {
		throw new Error(`build_stats ${name} must be a bounded lower-case category`);
	}

	return value;
};

const addStat = (stats: Map<string, BuildStatRowType>, row: BuildStatRowType): void => {
	if (!Number.isSafeInteger(row.value) || row.value < 0) {
		throw new Error('build_stats values must be non-negative safe integers');
	}

	const key = statKey(row);
	const existing = stats.get(key);

	stats.set(key, {
		...row,
		metric: boundedCategory(row.metric, 'metric'),
		value: (existing?.value ?? 0) + row.value,
	});
};

const exposureRank = (exposure: 'published' | 'reachable' | 'internal'): number => (exposure === 'published' ? 2 : exposure === 'reachable' ? 1 : 0);

const bindingExposures = (facts: FinalizedFactSetType): ReadonlyMap<string, 'published' | 'reachable' | 'internal'> => {
	const exposures = new Map<string, 'published' | 'reachable' | 'internal'>();

	for (const context of facts.bindingContexts) {
		const current = exposures.get(context.bindingId) ?? 'internal';

		if (exposureRank(context.exposure) > exposureRank(current)) {
			exposures.set(context.bindingId, context.exposure);
		} else if (!exposures.has(context.bindingId)) {
			exposures.set(context.bindingId, current);
		}
	}

	return exposures;
};

const groupedCount = (keys: readonly string[]): ReadonlyMap<string, number> => {
	const groups = new Map<string, number>();

	for (const key of keys) {
		groups.set(key, (groups.get(key) ?? 0) + 1);
	}

	return groups;
};

const coreBuildStats = (facts: FinalizedFactSetType, language: string): readonly BuildStatRowType[] => {
	const stats = new Map<string, BuildStatRowType>();
	const symbolGroups = groupedCount(facts.symbols.map((symbol: FinalizedSymbolType) => `${symbol.exposure}\u0000${symbol.kind}`));
	const exposures = bindingExposures(facts);
	const bindingGroups = groupedCount(facts.bindings.map((binding: FinalizedBindingType) => exposures.get(binding.bindingId) ?? 'internal'));
	const siteGroups = groupedCount(facts.bindingSites.map((site) => site.kind));
	const occurrenceGroups = groupedCount(facts.occurrences.map((occurrence) => `${occurrence.role}\u00000`));

	for (const [key, value] of symbolGroups) {
		const [exposure, kind] = key.split('\u0000');

		addStat(stats, {language, metric: 'symbols_stored', dim1: exposure ?? '', dim2: kind ?? '', dim3: '', value});
	}

	for (const [exposure, value] of bindingGroups) {
		addStat(stats, {language, metric: 'bindings', dim1: exposure, dim2: '', dim3: '', value});
	}

	for (const [kind, value] of siteGroups) {
		addStat(stats, {language, metric: 'sites', dim1: kind, dim2: '', dim3: '', value});
	}

	for (const [key, value] of occurrenceGroups) {
		const [role, usage] = key.split('\u0000');

		addStat(stats, {language, metric: 'occurrences_stored', dim1: role ?? '', dim2: usage ?? '0', dim3: '', value});
	}

	return [...stats.values()];
};

const adapterBuildStats = (facts: FinalizedFactSetType, language: string): readonly BuildStatRowType[] =>
	facts.adapterStats.map((stat) => {
		const dimensions = stat.dimensions ?? [];

		if (dimensions.length > 3) {
			throw new Error('build_stats supports at most three dimensions');
		}

		return {
			language,
			metric: stat.metric,
			dim1: dimensions[0] ?? '',
			dim2: dimensions[1] ?? '',
			dim3: dimensions[2] ?? '',
			value: stat.value,
		};
	});

/**
 * Derives the closed-category build statistics persisted with one generation.
 *
 * @param facts - Finalized facts and adapter aggregate statistics.
 * @param language - Adapter identifier used as the language category.
 * @returns Deterministically ordered statistic rows.
 * @throws {@link Error} When an adapter statistic has invalid dimensions or value.
 */
export const buildStatsOf = (facts: FinalizedFactSetType, language: string): readonly BuildStatRowType[] => {
	const stats = new Map<string, BuildStatRowType>();

	for (const row of [...coreBuildStats(facts, language), ...adapterBuildStats(facts, language)]) {
		addStat(stats, row);
	}

	return [...stats.values()].sort(
		(left, right) =>
			left.metric.localeCompare(right.metric) ||
			left.dim1.localeCompare(right.dim1) ||
			left.dim2.localeCompare(right.dim2) ||
			left.dim3.localeCompare(right.dim3),
	);
};
