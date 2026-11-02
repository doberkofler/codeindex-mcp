import {type ReadSymbolInputType, type ReadSymbolResultType} from '../model.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {resolveQueryScope, assertSymbolAdapter} from './queryScope.ts';
import {type QueryContextType} from './queryService.ts';
import {assertReferenceSelector, resolveReferenceQuery} from './referenceResolution.ts';
import {readSymbolAmbiguousResult, readSymbolNoneResult} from './readSymbolResult.ts';

export type ReadSymbolSelectionType = Readonly<{symbolId: string} | {result: ReadSymbolResultType}>;

export type ReadSymbolSelectionContextType = QueryContextType & Readonly<{maxResultBytes: number}>;

const unknownSymbolError = (symbolId: string): CodeIndexError =>
	new CodeIndexError(
		'symbol_not_found',
		`Unknown symbol: ${symbolId}. Symbol IDs are opaque; copy one from find_symbol or outline instead of constructing it.`,
	);

/**
 * Resolves exactly one read-symbol selector against one published generation.
 *
 * @param context - Database, generation, freshness, adapters, and response bound.
 * @param input - Symbol identifier or natural query and its filters.
 * @returns A symbol identifier or an ambiguity/no-match result.
 * @throws {@link CodeIndexError} When both or neither selector is supplied, the
 * context is unknown, or the selected symbol belongs to another adapter.
 */
export const selectReadSymbol = (context: ReadSymbolSelectionContextType, input: ReadSymbolInputType): ReadSymbolSelectionType => {
	const selector = assertReferenceSelector(input);
	const scope = resolveQueryScope({
		database: context.database,
		generationId: context.generationId,
		adapters: context.adapters,
		normalizers: context.normalizers,
		...(input.adapter === undefined ? {} : {adapter: input.adapter}),
		...(input.context === undefined ? {} : {context: input.context}),
	});

	if (selector === 'symbolId') {
		const symbolId = input.symbolId ?? '';
		const symbol = context.database.getSymbol(context.generationId, symbolId);

		if (symbol === null) {
			throw unknownSymbolError(symbolId);
		}

		assertSymbolAdapter(symbol.adapter, scope.adapter);

		return {symbolId};
	}

	const resolution = resolveReferenceQuery(
		context.database,
		context.generationId,
		{
			...input,
			limit: input.limit ?? 1,
			...(scope.adapter === undefined ? {} : {adapter: scope.adapter}),
			...(scope.context === undefined ? {} : {context: scope.context}),
		},
		{adapters: context.adapters, normalizers: context.normalizers},
	);

	if (resolution.kind === 'none') {
		return {result: readSymbolNoneResult(context.generationId, context.freshness)};
	}

	if (resolution.kind === 'ambiguous') {
		return {
			result: readSymbolAmbiguousResult({
				generationId: context.generationId,
				freshness: context.freshness,
				candidates: resolution.candidates,
				total: resolution.total,
				maxResultBytes: context.maxResultBytes,
			}),
		};
	}

	return {symbolId: resolution.symbolId};
};
