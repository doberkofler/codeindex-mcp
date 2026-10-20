import {
	type ExtractedBindingContextType,
	type ExtractedBindingSiteType,
	type ExtractedBindingType,
	type ExtractedOccurrenceType,
	type ExtractedPublicationFactsType,
	type FactAddressSegmentType,
	type FactAddressType,
	type FactExposureType,
	type FactSiteKindType,
} from '../../core/facts/index.ts';
import {type IndexedSymbolType} from '../../core/model.ts';

const PUBLISHED_CONTAINER_KINDS = new Set(['class', 'interface', 'enum', 'namespace']);
const DECLARED_SITE_KIND: FactSiteKindType = 'declared';

export type TypeScriptPublicationInputType = Readonly<{
	readonly context: string;
	readonly symbols: readonly IndexedSymbolType[];
	readonly occurrences: readonly ExtractedOccurrenceType[];
	readonly scopeByPath: ReadonlyMap<string, 'module' | 'global'>;
	readonly publishedSymbolIds: ReadonlySet<string>;
}>;

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const chainOf = (symbol: IndexedSymbolType, symbols: ReadonlyMap<string, IndexedSymbolType>, memo: Map<string, readonly string[]>): readonly string[] => {
	const existing = memo.get(symbol.id);

	if (existing !== undefined) {
		return existing;
	}

	const names: string[] = [symbol.name];
	const seen = new Set<string>([symbol.id]);
	let parentId = symbol.enclosingId;

	while (parentId !== null && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = symbols.get(parentId);

		if (parent === undefined) {
			break;
		}

		names.push(parent.name);
		parentId = parent.enclosingId;
	}

	names.reverse();
	memo.set(symbol.id, names);

	return names;
};

const addressOf = (
	symbol: IndexedSymbolType,
	symbols: ReadonlyMap<string, IndexedSymbolType>,
	scopeByPath: ReadonlyMap<string, 'module' | 'global'>,
	memo: Map<string, readonly string[]>,
): FactAddressType => {
	const names = chainOf(symbol, symbols, memo);
	const scope = scopeByPath.get(symbol.path) ?? 'module';
	const segments: FactAddressSegmentType[] = scope === 'module' ? [['module', symbol.path]] : [['global', null]];

	for (const name of names) {
		segments.push(['member', name]);
	}

	return segments;
};

const exposureOf = (
	symbol: IndexedSymbolType,
	symbols: ReadonlyMap<string, IndexedSymbolType>,
	publishedSymbolIds: ReadonlySet<string>,
	memo: Map<string, FactExposureType>,
): FactExposureType => {
	const existing = memo.get(symbol.id);

	if (existing !== undefined) {
		return existing;
	}

	let exposure: FactExposureType;

	if (publishedSymbolIds.has(symbol.id)) {
		exposure = 'published';
	} else {
		const parent = symbol.enclosingId === null ? undefined : symbols.get(symbol.enclosingId);

		if (parent === undefined) {
			exposure = 'internal';
		} else {
			const parentExposure = exposureOf(parent, symbols, publishedSymbolIds, memo);

			exposure =
				PUBLISHED_CONTAINER_KINDS.has(parent.kind) && parentExposure === 'published'
					? 'published'
					: PUBLISHED_CONTAINER_KINDS.has(parent.kind) && parentExposure === 'reachable'
						? 'reachable'
						: 'internal';
		}
	}

	memo.set(symbol.id, exposure);
	return exposure;
};

const siteRange = (
	symbol: IndexedSymbolType,
): Readonly<{
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	startOffset: number;
	endOffset: number;
}> => ({
	startLine: symbol.startLine,
	startColumn: symbol.startColumn,
	endLine: symbol.endLine,
	endColumn: symbol.endColumn,
	startOffset: symbol.startOffset,
	endOffset: symbol.endOffset,
});

/**
 * Emits preliminary lexical publication facts for one TypeScript context.
 *
 * Phase 1 deliberately limits this adapter to lexical bindings and declared
 * sites. Export aliases, default roots, surface projection, and reachability
 * closure remain Phase 4 work; the finalizer reports their measurement gaps
 * without persisting this classification.
 *
 * @param input - Symbols, occurrences, scope and publication roots for one context.
 * @returns Serializable bindings, contexts, sites, and empty surface origins.
 */
export const createTypeScriptPublicationFacts = (input: TypeScriptPublicationInputType): ExtractedPublicationFactsType => {
	const symbols = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
	const chainMemo = new Map<string, readonly string[]>();
	const exposureMemo = new Map<string, FactExposureType>();
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
		const segments = addressOf(symbol, symbols, input.scopeByPath, chainMemo);
		const exposure = exposureOf(symbol, symbols, input.publishedSymbolIds, exposureMemo);
		const definitions = definitionsBySymbol.get(symbol.id) ?? [];

		bindings.push({symbolId: symbol.id, segments});
		bindingContexts.push({symbolId: symbol.id, segments, context: input.context, exposure});

		for (const definition of definitions) {
			bindingSites.push({
				symbolId: symbol.id,
				segments,
				kind: DECLARED_SITE_KIND,
				path: definition.path,
				range: {
					startLine: definition.startLine,
					startColumn: definition.startColumn,
					endLine: definition.endLine,
					endColumn: definition.endColumn,
					startOffset: definition.startOffset,
					endOffset: definition.endOffset,
				},
			});
		}

		if (definitions.length === 0) {
			bindingSites.push({symbolId: symbol.id, segments, kind: DECLARED_SITE_KIND, path: symbol.path, range: siteRange(symbol)});
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
