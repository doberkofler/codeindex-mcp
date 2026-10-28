import {createHash} from 'node:crypto';
import {type IndexDatabase} from '../storage/database.ts';
import {type ReferenceScopeType} from '../storage/databaseReferenceQueries.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {type FindReferencesInputType, type FindReferencesResultType, type QueryFreshnessType} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath, withNormalizedQuery, type QueryNameNormalizerType} from './querySupport.ts';
import {groupedResultOf} from './referenceGrouping.ts';
import {assertReferenceSelector, resolveReferenceQuery, type ReferenceResolutionType} from './referenceResolution.ts';

type QueryContextType = Readonly<{
	database: IndexDatabase;
	generationId: string;
	freshness: QueryFreshnessType;
	normalizeQueryName?: QueryNameNormalizerType | undefined;
}>;

const NONE_MESSAGE =
	'No stored symbol matched this query. This is not evidence that no source defines it: the index covers only configured projects and indexing may be incomplete. Use a repository text search as the fallback.';

const assertKnownContext = (context: QueryContextType, requested: string | undefined): void => {
	if (requested === undefined) {
		return;
	}

	const known = context.database.listProjectContextNames(context.generationId);

	if (!known.includes(requested)) {
		throw new CodeIndexError('invalid_argument', `Unknown project context: ${requested}. Available contexts: ${known.join(', ')}`);
	}
};

/**
 * Hashes the complete reference query identity into a compact cursor tag.
 *
 * @param identity - Selector, filters, group, and effective role.
 * @returns A stable base64url tag bound to this query.
 */
const queryTagOf = (identity: readonly (string | number | null)[]): string =>
	createHash('sha256')
		.update(JSON.stringify(['find_references', ...identity]), 'utf8')
		.digest('base64url');

const scopeOf = (input: FindReferencesInputType, role: 'definition' | 'reference' | undefined, path: string | undefined): ReferenceScopeType => ({
	generationId: '',
	symbolId: '',
	...(role === undefined ? {} : {role}),
	...(path === undefined ? {} : {path}),
	...(input.enclosingId === undefined ? {} : {enclosingId: input.enclosingId}),
	...(input.usage === undefined ? {} : {usage: input.usage}),
	...(input.context === undefined ? {} : {context: input.context}),
});

const withSymbol = (scope: ReferenceScopeType, generationId: string, symbolId: string): ReferenceScopeType => ({...scope, generationId, symbolId});

const noneResultOf = (context: QueryContextType): FindReferencesResultType => ({
	kind: 'none',
	generationId: context.generationId,
	freshness: context.freshness,
	selector: 'query',
	reason: 'no_stored_match',
	fallback: 'text_search',
	message: NONE_MESSAGE,
	limitations: ['Only configured extractor projects are indexed.', 'Indexing may be incomplete.', 'A missing stored symbol is not a source-absence claim.'],
});

const ambiguousResultOf = (context: QueryContextType, resolution: ReferenceResolutionType & {kind: 'ambiguous'}): FindReferencesResultType => ({
	kind: 'ambiguous',
	generationId: context.generationId,
	freshness: context.freshness,
	selector: 'query',
	candidates: resolution.candidates,
	candidatesTotal: resolution.total,
	candidatesTruncated: resolution.total > resolution.candidates.length,
});

const unknownSymbolError = (symbolId: string): CodeIndexError =>
	new CodeIndexError(
		'symbol_not_found',
		`Unknown symbol: ${symbolId}. Symbol IDs are opaque; copy one from find_symbol or outline instead of constructing it.`,
	);

const selectSymbol = (
	context: QueryContextType,
	input: FindReferencesInputType,
	selector: 'symbolId' | 'query',
	path: string | undefined,
): Readonly<{symbolId: string} | {result: FindReferencesResultType}> => {
	if (selector === 'symbolId') {
		const symbolId = input.symbolId ?? '';

		if (context.database.getSymbol(context.generationId, symbolId) === null) {
			throw unknownSymbolError(symbolId);
		}

		return {symbolId};
	}

	const resolution = resolveReferenceQuery(context.database, context.generationId, {...withNormalizedQuery(context.normalizeQueryName, input), path});

	if (resolution.kind === 'none') {
		return {result: noneResultOf(context)};
	}

	if (resolution.kind === 'ambiguous') {
		return {result: ambiguousResultOf(context, resolution)};
	}

	return {symbolId: resolution.symbolId};
};

const occurrenceResultOf = (
	input: Readonly<{
		context: QueryContextType;
		query: FindReferencesInputType;
		scope: ReferenceScopeType;
		selector: 'symbolId' | 'query';
		queryKind: string;
		offset: number;
		maxResultBytes: number;
	}>,
): FindReferencesResultType => {
	const rows = input.context.database.findReferenceRows({...input.scope, limit: input.query.limit, offset: input.offset});
	const items = rows.slice(0, input.query.limit);
	const coverage = input.context.database.referenceCoverage({
		generationId: input.context.generationId,
		symbolId: input.scope.symbolId,
		filters: input.scope,
	});
	const totals = input.context.database.referenceTotals({generationId: input.context.generationId, symbolId: input.scope.symbolId, filters: input.scope});

	return boundedPagedResult({
		generationId: input.context.generationId,
		items,
		offset: input.offset,
		queryKind: input.queryKind,
		hasMore: rows.length > items.length,
		maxResultBytes: input.maxResultBytes,
		createResult: (page) => ({
			kind: 'occurrences',
			generationId: input.context.generationId,
			freshness: input.context.freshness,
			selector: input.selector,
			group: 'occurrence',
			occurrencesTotal: totals.occurrencesTotal,
			definitionsTotal: totals.definitionsTotal,
			unclassifiedReferences: coverage.unclassifiedReferences,
			crossFileRefsObserved: coverage.crossFileRefsObserved,
			items: page.items,
			nextCursor: page.nextCursor,
			truncated: page.truncated,
		}),
	});
};

const queryIdentityOf = (
	input: Readonly<{
		selector: 'symbolId' | 'query';
		symbolId: string;
		request: FindReferencesInputType;
		group: 'occurrence' | 'file' | 'owner';
		role: 'definition' | 'reference' | undefined;
		path: string | undefined;
	}>,
): readonly (string | number | null)[] => [
	input.selector,
	input.symbolId,
	input.selector === 'query' ? (input.request.query ?? '').trim() : null,
	input.request.match ?? null,
	input.request.kind ?? null,
	input.request.container ?? null,
	input.request.exposure ?? null,
	input.group,
	input.role ?? null,
	input.path ?? null,
	input.request.enclosingId ?? null,
	input.request.usage ?? null,
	input.request.context ?? null,
];

/**
 * Finds stored occurrences for one symbol identifier or one symbol query.
 *
 * A `symbolId` selector keeps the flat occurrence contract and defaults to
 * occurrence grouping. A `query` selector resolves one symbol without a second
 * call and defaults to file grouping. Grouped results count one occurrence per
 * path, start offset, and role, independent of context-row count.
 *
 * @param context - Database, published generation, and freshness.
 * @param input - Selector, filters, grouping, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Flat occurrences, file groups, owner groups, ambiguity, or no match.
 * @throws {@link CodeIndexError} When selectors conflict, the symbol is unknown, a filter conflicts, or the cursor is invalid.
 */
export const findReferences = (context: QueryContextType, input: FindReferencesInputType, maxResultBytes: number): FindReferencesResultType => {
	const selector = assertReferenceSelector(input);
	const normalizedPath = input.path === undefined ? undefined : normalizeRelativePath(input.path);
	assertKnownContext(context, input.context);
	const selection = selectSymbol(context, input, selector, normalizedPath);

	if ('result' in selection) {
		return selection.result;
	}

	const group = input.group ?? (selector === 'query' ? 'file' : 'occurrence');
	const role = input.role ?? (group === 'occurrence' ? undefined : 'reference');

	if (input.usage !== undefined && role === 'definition') {
		throw new CodeIndexError('invalid_argument', 'usage filtering is not valid with role: definition');
	}

	const queryKind = queryTagOf(queryIdentityOf({selector, symbolId: selection.symbolId, request: input, group, role, path: normalizedPath}));
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const scope = withSymbol(scopeOf(input, role, normalizedPath), context.generationId, selection.symbolId);

	return group === 'occurrence'
		? occurrenceResultOf({context, query: input, scope, selector, queryKind, offset, maxResultBytes})
		: groupedResultOf({
				context,
				query: input,
				scope,
				selector,
				group,
				queryKind,
				offset,
				maxResultBytes,
			});
};
