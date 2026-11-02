import {createHash} from 'node:crypto';
import {type ReferenceScopeType} from '../storage/databaseReferenceQueries.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {type FindReferencesInputType, type FindReferencesResultType} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath} from './querySupport.ts';
import {groupedResultOf} from './referenceGrouping.ts';
import {resolveReferencePartition, type ResolvedReferencePartitionType} from './referencePartition.ts';
import {assertReferenceSelector, resolveReferenceQuery, type ReferenceResolutionType} from './referenceResolution.ts';
import {assertSymbolAdapter, resolveQueryScope, type QueryScopeType} from './queryScope.ts';
import {type QueryContextType} from './queryService.ts';

const NONE_MESSAGE =
	'No stored symbol matched this query. This is not evidence that no source defines it: the index covers only configured projects and indexing may be incomplete. Use a repository text search as the fallback.';

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

const scopeOf = (
	input: Readonly<{
		request: FindReferencesInputType;
		scope: QueryScopeType;
		role: 'definition' | 'reference' | undefined;
		path: string | undefined;
		symbolIds: readonly string[];
	}>,
): ReferenceScopeType => ({
	generationId: '',
	symbolId: '',
	symbolIds: input.symbolIds,
	...(input.role === undefined ? {} : {role: input.role}),
	...(input.path === undefined ? {} : {path: input.path}),
	...(input.request.enclosingId === undefined ? {} : {enclosingId: input.request.enclosingId}),
	...(input.request.usage === undefined ? {} : {usage: input.request.usage}),
	...(input.scope.adapter === undefined ? {} : {adapter: input.scope.adapter}),
	...(input.scope.context === undefined ? {} : {context: input.scope.context}),
});

const withSymbol = (scope: ReferenceScopeType, generationId: string, symbolId: string): ReferenceScopeType => ({...scope, generationId, symbolId});

const noneResultOf = (context: QueryContextType): FindReferencesResultType => ({
	kind: 'none',
	generationId: context.generationId,
	freshness: context.freshness,
	selector: 'query',
	partition: null,
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
	partition: null,
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
	input: Readonly<{
		context: QueryContextType;
		request: FindReferencesInputType;
		scope: QueryScopeType;
		selector: 'symbolId' | 'query';
		path: string | undefined;
	}>,
): Readonly<{symbolId: string} | {result: FindReferencesResultType}> => {
	const {context, request, scope, selector, path} = input;

	if (selector === 'symbolId') {
		const symbolId = request.symbolId ?? '';
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
		{...request, ...(scope.adapter === undefined ? {} : {adapter: scope.adapter}), ...(scope.context === undefined ? {} : {context: scope.context}), path},
		{adapters: context.adapters, normalizers: context.normalizers},
	);

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
		partition: ResolvedReferencePartitionType['partition'];
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
			partition: input.partition,
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
		scope: QueryScopeType;
		group: 'occurrence' | 'file' | 'owner';
		role: 'definition' | 'reference' | undefined;
		path: string | undefined;
		partitionScope: 'partition' | 'external_alias_group';
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
	input.scope.adapter ?? null,
	input.scope.context ?? null,
	input.partitionScope,
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
	const scope = resolveQueryScope({
		database: context.database,
		generationId: context.generationId,
		adapters: context.adapters,
		normalizers: context.normalizers,
		...(input.adapter === undefined ? {} : {adapter: input.adapter}),
		...(input.context === undefined ? {} : {context: input.context}),
	});
	const selection = selectSymbol({context, request: input, scope, selector, path: normalizedPath});

	if ('result' in selection) {
		return selection.result;
	}

	const group = input.group ?? (selector === 'query' ? 'file' : 'occurrence');
	const role = input.role ?? (group === 'occurrence' ? undefined : 'reference');

	if (input.usage !== undefined && role === 'definition') {
		throw new CodeIndexError('invalid_argument', 'usage filtering is not valid with role: definition');
	}

	const requestedScope = input.scope ?? 'partition';
	const resolved = resolveReferencePartition(context.database, context.generationId, selection.symbolId, {
		scope: requestedScope,
		...(scope.adapter === undefined ? {} : {adapter: scope.adapter}),
	});
	const queryKind = queryTagOf(
		queryIdentityOf({
			selector,
			symbolId: selection.symbolId,
			request: input,
			scope,
			group,
			role,
			path: normalizedPath,
			partitionScope: requestedScope,
		}),
	);
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const referenceScope = withSymbol(
		scopeOf({request: input, scope, role, path: normalizedPath, symbolIds: resolved.symbolIds}),
		context.generationId,
		selection.symbolId,
	);

	return group === 'occurrence'
		? occurrenceResultOf({context, query: input, scope: referenceScope, selector, partition: resolved.partition, queryKind, offset, maxResultBytes})
		: groupedResultOf({
				context,
				query: input,
				scope: referenceScope,
				selector,
				partition: resolved.partition,
				group,
				queryKind,
				offset,
				maxResultBytes,
			});
};
