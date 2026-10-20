import {
	type AdapterStatType,
	type ExtractedBindingContextType,
	type ExtractedBindingSiteType,
	type ExtractedBindingType,
	type ExtractedSurfaceOriginType,
} from '../../core/facts/index.ts';
import {type IndexedSymbolType} from '../../core/model.ts';
import {type ExtractionRuntimeType} from './extractionRuntime.ts';
import {type FactSinkType} from './extractionRoots.ts';

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const addressKey = (segments: ExtractedBindingType['segments']): string => JSON.stringify(segments);

/**
 * Builds canonical binding rows from accumulated drafts.
 *
 * @param sink - Fact sink.
 * @param context - Project context name.
 * @returns Bindings, contexts, sites, and surface origins in deterministic order.
 */
export const publicationFactsOf = (
	sink: FactSinkType,
	context: string,
): Readonly<{
	bindings: readonly ExtractedBindingType[];
	bindingContexts: readonly ExtractedBindingContextType[];
	bindingSites: readonly ExtractedBindingSiteType[];
	surfaceOrigins: readonly ExtractedSurfaceOriginType[];
}> => {
	const bindings = [...sink.bindings.values()]
		.map((draft) => ({symbolId: draft.symbolId, segments: draft.segments}))
		.sort((left, right) => compareText(left.symbolId, right.symbolId) || compareText(addressKey(left.segments), addressKey(right.segments)));
	const bindingContexts = [...sink.bindings.values()]
		.map((draft) => ({symbolId: draft.symbolId, segments: draft.segments, context, exposure: draft.exposure}))
		.sort(
			(left, right) =>
				compareText(left.context, right.context) ||
				compareText(left.symbolId, right.symbolId) ||
				compareText(addressKey(left.segments), addressKey(right.segments)),
		);
	const bindingSites = [...sink.bindings.values()]
		.flatMap((draft) =>
			[...draft.sites.values()].map((site) => ({
				symbolId: draft.symbolId,
				segments: draft.segments,
				kind: site.kind,
				path: site.path,
				range: site.range,
			})),
		)
		.sort(
			(left, right) =>
				compareText(left.path, right.path) ||
				left.range.startOffset - right.range.startOffset ||
				compareText(left.kind, right.kind) ||
				compareText(left.symbolId, right.symbolId),
		);
	const surfaceOrigins = [...sink.origins].sort(
		(left, right) => compareText(left.symbolId, right.symbolId) || compareText(addressKey(left.segments), addressKey(right.segments)),
	);

	return {bindings, bindingContexts, bindingSites, surfaceOrigins};
};

/**
 * Builds adapter-emitted aggregate statistics.
 *
 * @param runtime - Extraction state.
 * @param sink - Fact sink.
 * @param dropped - Dropped occurrence counts.
 * @returns Closed-category adapter statistics.
 */
export const adapterStatsOf = (
	runtime: ExtractionRuntimeType,
	sink: FactSinkType,
	dropped: Readonly<Record<'external_target' | 'ephemeral_target', number>>,
): readonly AdapterStatType[] => {
	const stats: AdapterStatType[] = [];

	for (const [kind, value] of runtime.collection.ephemeralKinds) {
		stats.push({metric: 'ephemeral_declarations', value, dimensions: [kind]});
	}

	for (const [reason, value] of Object.entries(dropped)) {
		if (value > 0) {
			stats.push({metric: 'occurrences_dropped', value, dimensions: [reason]});
		}
	}

	for (const [kind, value] of [
		['anonymous', sink.surfaceFlags.anonymous],
		['inherited', sink.surfaceFlags.inherited],
		['depth1', sink.surfaceFlags.depthOne],
	] as const) {
		if (value > 0) {
			stats.push({metric: 'surface_bindings', value, dimensions: [kind]});
		}
	}

	stats.push(
		{metric: 'projection_budget_observed', value: sink.maxAddresses, dimensions: ['addresses', 'maximum']},
		{metric: 'projection_budget_observed', value: sink.maxSteps, dimensions: ['reachability_steps', 'maximum']},
	);

	if (runtime.collection.externalAliases > 0) {
		stats.push({metric: 'external_aliases', value: runtime.collection.externalAliases});
	}

	if (runtime.collection.externalStars > 0) {
		stats.push({metric: 'external_reexports', value: runtime.collection.externalStars, dimensions: ['star']});
	}

	if (runtime.collection.mergedDeclarationCount > 0) {
		const kinds = new Map<string, number>();

		for (const candidate of runtime.collection.candidates.values()) {
			if (candidate.definitions.length < 2) {
				continue;
			}

			const key = [...new Set(candidate.definitions.map((definition) => definition.kind))].sort().join('+');
			kinds.set(key, (kinds.get(key) ?? 0) + 1);
		}

		for (const [kind, value] of kinds) {
			stats.push({metric: 'merged_declarations', value, dimensions: [kind]});
		}
	}

	return stats;
};

/**
 * Returns stored symbols in deterministic source order.
 *
 * @param runtime - Extraction state.
 * @returns Sorted symbol rows.
 */
export const sortedSymbols = (runtime: ExtractionRuntimeType): readonly IndexedSymbolType[] =>
	[...runtime.symbolsById.values()].sort(
		(left, right) => left.path.localeCompare(right.path) || left.startOffset - right.startOffset || left.id.localeCompare(right.id),
	);
