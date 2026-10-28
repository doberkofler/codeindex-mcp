import {type QueryFreshnessType, type ReadSymbolInputType, type ReadSymbolResultType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {assertKnownContext} from './queryService.ts';
import {assertReferenceSelector, resolveReferenceQuery} from './referenceResolution.ts';
import {readSymbolAmbiguousResult, readSymbolNoneResult} from './readSymbolResult.ts';

type SelectionContextType = Readonly<{
	database: IndexDatabase;
	generationId: string;
	freshness: QueryFreshnessType;
	maxResultBytes: number;
}>;

export type ReadSymbolSelectionType = Readonly<{symbolId: string} | {result: ReadSymbolResultType}>;

/**
 * Resolves exactly one read-symbol selector against one published generation.
 *
 * @param context - Database, generation, freshness, and response bound.
 * @param input - Symbol identifier or natural query and its filters.
 * @returns A symbol identifier or an ambiguity/no-match result.
 * @throws {@link CodeIndexError} When both or neither selector is supplied or the context is unknown.
 */
export const selectReadSymbol = (context: SelectionContextType, input: ReadSymbolInputType): ReadSymbolSelectionType => {
	const selector = assertReferenceSelector(input);
	assertKnownContext(context, input.context);

	if (selector === 'symbolId') {
		return {symbolId: input.symbolId ?? ''};
	}

	const resolution = resolveReferenceQuery(context.database, context.generationId, {
		query: input.query,
		match: input.match,
		kind: input.kind,
		container: input.container,
		path: input.path,
		exposure: input.exposure,
		context: input.context,
		limit: 1,
	});

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
