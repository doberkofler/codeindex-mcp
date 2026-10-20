import {type IndexedSymbolType} from '../model.ts';
import {compareRanges, occurrenceRange} from './address.ts';
import {type BindingEntryType, type PendingSiteType, primaryBindingOf} from './bindings.ts';
import {compareFactText, createFactId, displayBinding} from './canonical.ts';
import {addIssue} from './issues.ts';
import {type ExtractedOccurrenceType, type FactExposureType, type FactIssueType, type FinalizedSymbolType, type SymbolExposureType} from './types.ts';

const MAX_RANK = Number.MAX_SAFE_INTEGER;

const rankOf = (occurrence: ExtractedOccurrenceType, field: 'anchorRank' | 'primaryRank'): number => occurrence[field] ?? MAX_RANK;

/**
 * Selects the deterministic first definition after applying an adapter rank.
 *
 * @param definitions - Definitions for one symbol.
 * @param field - Rank field to apply.
 * @returns The selected occurrence, or null.
 */
const selectDefinition = (definitions: readonly ExtractedOccurrenceType[], field: 'anchorRank' | 'primaryRank'): ExtractedOccurrenceType | null => {
	let selected: ExtractedOccurrenceType | null = null;

	for (const candidate of definitions) {
		if (selected === null) {
			selected = candidate;
			continue;
		}

		const rank = rankOf(candidate, field) - rankOf(selected, field);

		if (rank < 0) {
			selected = candidate;
			continue;
		}

		if (rank > 0) {
			continue;
		}

		const pathOrder = compareFactText(candidate.path, selected.path);

		if (pathOrder < 0) {
			selected = candidate;
			continue;
		}

		if (pathOrder > 0) {
			continue;
		}

		const rangeOrder = compareRanges(occurrenceRange(candidate), occurrenceRange(selected));

		if (rangeOrder < 0 || (rangeOrder === 0 && compareFactText(candidate.symbolId, selected.symbolId) < 0)) {
			selected = candidate;
		}
	}

	return selected;
};

const exposureRank = (exposure: FactExposureType): number => (exposure === 'published' ? 2 : exposure === 'reachable' ? 1 : 0);

// Derives symbol exposure from all binding-context exposures.
const symbolExposureOf = (exposures: readonly FactExposureType[]): SymbolExposureType => {
	let selected: FactExposureType = 'internal';

	for (const exposure of exposures) {
		if (exposureRank(exposure) > exposureRank(selected)) {
			selected = exposure;
		}
	}

	return selected === 'internal' ? 'internal_only' : selected;
};

const rangeOfSymbol = (symbol: IndexedSymbolType): ReturnType<typeof occurrenceRange> => ({
	startLine: symbol.startLine,
	startColumn: symbol.startColumn,
	endLine: symbol.endLine,
	endColumn: symbol.endColumn,
	startOffset: symbol.startOffset,
	endOffset: symbol.endOffset,
});

type FinalizeSymbolInputType = Readonly<{
	readonly symbol: IndexedSymbolType;
	readonly definitions: readonly ExtractedOccurrenceType[];
	readonly entriesForSymbol: readonly BindingEntryType[];
	readonly exposuresByBinding: ReadonlyMap<string, readonly FactExposureType[]>;
	readonly sitesByBinding: ReadonlyMap<string, readonly PendingSiteType[]>;
	readonly issues: FactIssueType[];
}>;

const finalizeSymbol = (input: FinalizeSymbolInputType): FinalizedSymbolType => {
	const primary = selectDefinition(input.definitions, 'primaryRank');
	const anchor = selectDefinition(input.definitions, 'anchorRank');
	const binding = primaryBindingOf(primary, input.entriesForSymbol, input.sitesByBinding);
	const range = primary?.extent ?? (primary === null ? rangeOfSymbol(input.symbol) : occurrenceRange(primary));
	const exposures = input.entriesForSymbol.flatMap((entry) => input.exposuresByBinding.get(entry.bindingId) ?? []);

	if (primary === null) {
		addIssue(input.issues, 'missing_definition', 'symbol has no definition occurrence', {symbolId: input.symbol.id});
	}

	if (binding === null) {
		addIssue(input.issues, 'missing_binding_site', 'symbol has no searchable binding', {symbolId: input.symbol.id});
	}

	return {
		...input.symbol,
		name: binding === null ? input.symbol.name : displayBinding(binding.binding.segments).name,
		qualifiedName: binding === null ? input.symbol.qualifiedName : displayBinding(binding.binding.segments).qualifiedName,
		kind: anchor?.declarationKind ?? input.symbol.kind,
		path: primary?.path ?? input.symbol.path,
		startLine: range.startLine,
		startColumn: range.startColumn,
		endLine: range.endLine,
		endColumn: range.endColumn,
		startOffset: range.startOffset,
		endOffset: range.endOffset,
		exposure: symbolExposureOf(exposures),
		primaryDefinitionSiteId: primary === null ? '' : createFactId('o_', [input.symbol.id, primary.path, String(primary.startOffset), 'definition']),
		primaryBindingId: binding?.bindingId ?? null,
	};
};

type FinalizeSymbolsInputType = Readonly<{
	readonly symbols: readonly IndexedSymbolType[];
	readonly definitionsBySymbol: ReadonlyMap<string, readonly ExtractedOccurrenceType[]>;
	readonly entriesBySymbol: ReadonlyMap<string, readonly BindingEntryType[]>;
	readonly exposuresByBinding: ReadonlyMap<string, readonly FactExposureType[]>;
	readonly sitesByBinding: ReadonlyMap<string, readonly PendingSiteType[]>;
	readonly issues: FactIssueType[];
}>;

/**
 * Derives the navigable symbol records and their exposure.
 *
 * @param input - Symbols, grouped definitions, bindings, exposures, sites, and issues.
 * @returns Finalized symbols in deterministic source order.
 */
export const finalizeSymbols = (input: FinalizeSymbolsInputType): readonly FinalizedSymbolType[] =>
	input.symbols
		.map((symbol) =>
			finalizeSymbol({
				symbol,
				definitions: input.definitionsBySymbol.get(symbol.id) ?? [],
				entriesForSymbol: input.entriesBySymbol.get(symbol.id) ?? [],
				exposuresByBinding: input.exposuresByBinding,
				sitesByBinding: input.sitesByBinding,
				issues: input.issues,
			}),
		)
		.sort((left, right) => compareFactText(left.path, right.path) || left.startOffset - right.startOffset || compareFactText(left.id, right.id));
