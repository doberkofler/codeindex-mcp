import {
	type ExtractedBindingContextType,
	type ExtractedBindingSiteType,
	type ExtractedBindingType,
	type ExtractedOccurrenceType,
	type ExtractedPublicationFactsType,
	type FactAddressSegmentType,
	type FactAddressType,
	type FactSiteKindType,
} from '../../core/facts/index.ts';
import {type IndexedSymbolType} from '../../core/model.ts';

const DECLARED_SITE_KIND: FactSiteKindType = 'declared';

export type OraclePublicationSymbolMetadataType = Readonly<{
	readonly owner: string;
	readonly canonicalName: string;
	readonly exported: boolean;
}>;

export type OraclePublicationInputType = Readonly<{
	readonly context: string;
	readonly symbols: readonly IndexedSymbolType[];
	readonly occurrences: readonly ExtractedOccurrenceType[];
	readonly metadata: ReadonlyMap<string, OraclePublicationSymbolMetadataType>;
}>;

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const canonicalNameOf = (symbol: IndexedSymbolType, metadata: ReadonlyMap<string, OraclePublicationSymbolMetadataType>): string =>
	metadata.get(symbol.id)?.canonicalName ?? symbol.name;

const chainOf = (
	symbol: IndexedSymbolType,
	symbols: ReadonlyMap<string, IndexedSymbolType>,
	metadata: ReadonlyMap<string, OraclePublicationSymbolMetadataType>,
	memo: Map<string, readonly string[]>,
): readonly string[] => {
	const existing = memo.get(symbol.id);

	if (existing !== undefined) {
		return existing;
	}

	const names: string[] = [canonicalNameOf(symbol, metadata)];
	const seen = new Set<string>([symbol.id]);
	let parentId = symbol.enclosingId;

	while (parentId !== null && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = symbols.get(parentId);

		if (parent === undefined) {
			break;
		}

		names.push(canonicalNameOf(parent, metadata));
		parentId = parent.enclosingId;
	}

	names.reverse();
	memo.set(symbol.id, names);
	return names;
};

const addressOf = (
	symbol: IndexedSymbolType,
	symbols: ReadonlyMap<string, IndexedSymbolType>,
	metadata: ReadonlyMap<string, OraclePublicationSymbolMetadataType>,
	memo: Map<string, readonly string[]>,
): FactAddressType => {
	const owner = metadata.get(symbol.id)?.owner ?? '';
	const names = chainOf(symbol, symbols, metadata, memo);
	const segments: FactAddressSegmentType[] = [['owner', owner]];

	for (const name of names) {
		segments.push(['member', name]);
	}

	return segments;
};

const rangeOf = (
	occurrence: ExtractedOccurrenceType,
): Readonly<{
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	startOffset: number;
	endOffset: number;
}> => ({
	startLine: occurrence.startLine,
	startColumn: occurrence.startColumn,
	endLine: occurrence.endLine,
	endColumn: occurrence.endColumn,
	startOffset: occurrence.startOffset,
	endOffset: occurrence.endOffset,
});

/**
 * Emits preliminary lexical publication facts for one Oracle context.
 *
 * Oracle exposure is already source-local after spec/body pairing: declarations
 * exported by a package specification or standalone unit are published, while
 * body-only declarations are internal. Phase 1 does not project package member
 * addresses or classify declaration forms beyond this lexical view.
 *
 * @param input - Symbols, definition occurrences, and owner metadata.
 * @returns Serializable bindings, contexts, sites, and empty surface origins.
 */
export const createOraclePublicationFacts = (input: OraclePublicationInputType): ExtractedPublicationFactsType => {
	const symbols = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
	const chainMemo = new Map<string, readonly string[]>();
	const definitionsBySymbol = new Map<string, ExtractedOccurrenceType[]>();

	for (const occurrence of input.occurrences) {
		if (occurrence.role !== 'definition') {
			continue;
		}

		const group = definitionsBySymbol.get(occurrence.symbolId) ?? [];
		group.push(occurrence);
		definitionsBySymbol.set(occurrence.symbolId, group);
	}

	const bindings: ExtractedBindingType[] = [];
	const bindingContexts: ExtractedBindingContextType[] = [];
	const bindingSites: ExtractedBindingSiteType[] = [];

	for (const symbol of symbols.values()) {
		const segments = addressOf(symbol, symbols, input.metadata, chainMemo);
		const exposure = input.metadata.get(symbol.id)?.exported === true ? 'published' : 'internal';
		const definitions = definitionsBySymbol.get(symbol.id) ?? [];

		bindings.push({symbolId: symbol.id, segments});
		bindingContexts.push({symbolId: symbol.id, segments, context: input.context, exposure});

		for (const definition of definitions) {
			bindingSites.push({symbolId: symbol.id, segments, kind: DECLARED_SITE_KIND, path: definition.path, range: rangeOf(definition)});
		}

		if (definitions.length === 0) {
			bindingSites.push({
				symbolId: symbol.id,
				segments,
				kind: DECLARED_SITE_KIND,
				path: symbol.path,
				range: {
					startLine: symbol.startLine,
					startColumn: symbol.startColumn,
					endLine: symbol.endLine,
					endColumn: symbol.endColumn,
					startOffset: symbol.startOffset,
					endOffset: symbol.endOffset,
				},
			});
		}
	}

	bindings.sort((left, right) => compareText(left.symbolId, right.symbolId) || compareText(JSON.stringify(left.segments), JSON.stringify(right.segments)));
	bindingContexts.sort(
		(left, right) =>
			compareText(left.context, right.context) ||
			compareText(left.symbolId, right.symbolId) ||
			compareText(JSON.stringify(left.segments), JSON.stringify(right.segments)),
	);
	bindingSites.sort(
		(left, right) => compareText(left.path, right.path) || left.range.startOffset - right.range.startOffset || compareText(left.symbolId, right.symbolId),
	);

	return {bindings, bindingContexts, bindingSites, surfaceOrigins: []};
};
