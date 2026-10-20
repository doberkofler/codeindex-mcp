import {type BindingEntryType, bindingExposureOf, type PendingSiteType} from './bindings.ts';
import {
	type FinalizationStatsType,
	type FinalizedBindingContextType,
	type FinalizedBindingType,
	type FinalizedSymbolType,
	type FinalizedSurfaceOriginType,
	type ExtractedFactSetType,
} from './types.ts';

/**
 * Computes aggregate report and persistence statistics.
 *
 * @param input - Finalized rows and the originating fact bundle.
 * @returns Aggregate counts only.
 */
export const finalizationStatsOf = (
	input: Readonly<{
		readonly facts: ExtractedFactSetType;
		readonly entries: ReadonlyMap<string, BindingEntryType>;
		readonly symbols: readonly FinalizedSymbolType[];
		readonly bindings: readonly FinalizedBindingType[];
		readonly contexts: readonly FinalizedBindingContextType[];
		readonly sites: readonly PendingSiteType[];
		readonly origins: readonly FinalizedSurfaceOriginType[];
		readonly maxSurfaceBindingsPerRoot: number;
	}>,
): FinalizationStatsType => {
	const definitionCount = input.facts.occurrences.filter((occurrence) => occurrence.role === 'definition').length;
	const exposuresByBinding = new Map<string, ReturnType<typeof bindingExposureOf>[]>();

	for (const context of input.contexts) {
		const exposures = exposuresByBinding.get(context.bindingId) ?? [];
		exposures.push(context.exposure);
		exposuresByBinding.set(context.bindingId, exposures);
	}

	const bindingExposures = input.bindings.map((binding) => bindingExposureOf(exposuresByBinding.get(binding.bindingId) ?? []));
	const symbolExposures = input.symbols.map((symbol) => symbol.exposure);
	const bindingsPerSymbol = new Map<string, number>();
	let maxBindingsPerSymbol = 0;

	for (const entry of input.entries.values()) {
		const count = (bindingsPerSymbol.get(entry.binding.symbolId) ?? 0) + 1;
		bindingsPerSymbol.set(entry.binding.symbolId, count);
		maxBindingsPerSymbol = Math.max(maxBindingsPerSymbol, count);
	}

	return {
		symbols: input.symbols.length,
		bindings: input.bindings.length,
		bindingContexts: input.contexts.length,
		bindingSites: input.sites.length,
		surfaceOrigins: input.origins.length,
		occurrences: input.facts.occurrences.length,
		definitions: definitionCount,
		references: input.facts.occurrences.length - definitionCount,
		publishedSymbols: symbolExposures.filter((exposure) => exposure === 'published').length,
		reachableSymbols: symbolExposures.filter((exposure) => exposure === 'reachable').length,
		internalOnlySymbols: symbolExposures.filter((exposure) => exposure === 'internal_only').length,
		publishedBindings: bindingExposures.filter((exposure) => exposure === 'published').length,
		reachableBindings: bindingExposures.filter((exposure) => exposure === 'reachable').length,
		internalBindings: bindingExposures.filter((exposure) => exposure === 'internal').length,
		maxBindingsPerSymbol,
		maxSurfaceBindingsPerRoot: input.maxSurfaceBindingsPerRoot,
	};
};
