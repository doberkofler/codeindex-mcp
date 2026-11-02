import {type IndexDatabase} from '../storage/database.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {
	type BindingDetailType,
	type BindingSummaryType,
	type ExactNamePresenceType,
	type FindSymbolInputType,
	type FindSymbolItemType,
	type FindSymbolResultType,
	type QueryFreshnessType,
	type SymbolSummaryType,
} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath, type QueryNameNormalizerType} from './querySupport.ts';
import {type BindingCandidateType} from '../storage/databasePublicationQueries.ts';
import {groupNormalizedQueries, normalizedQueryEntries, resolveQueryScope, type QueryScopeType} from './queryScope.ts';

export type QueryContextType = Readonly<{
	readonly database: IndexDatabase;
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	/** Configured adapter identifiers in declaration order. */
	readonly adapters: readonly string[];
	/** Adapter-owned query-name normalization, keyed by adapter identifier. */
	readonly normalizers: ReadonlyMap<string, QueryNameNormalizerType>;
	/** Optional local analytics sink for exact-name presence outcomes. */
	readonly exactNameTelemetry?: ((presence: ExactNamePresenceType) => void) | undefined;
}>;

const exposureRank = (exposure: 'published' | 'reachable' | 'internal'): number => (exposure === 'published' ? 2 : exposure === 'reachable' ? 1 : 0);

const matchRank = (match: BindingCandidateType['match']): number => (match.startsWith('exact') ? 0 : 1);

const compareTuples = (left: readonly (number | string)[], right: readonly (number | string)[]): number => {
	for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;

		if (leftValue < rightValue) {
			return -1;
		}

		if (leftValue > rightValue) {
			return 1;
		}
	}

	return left.length - right.length;
};

const primaryBindingOf = (details: readonly BindingDetailType[], symbolStart: number, symbolEnd: number): BindingDetailType | null => {
	let selected: BindingDetailType | null = null;

	for (const detail of details) {
		if (selected === null) {
			selected = detail;
			continue;
		}

		const leftMatches = detail.sites.some(
			(site) => (site.kind === 'declared' || site.kind === 'default') && site.start === symbolStart && site.end === symbolEnd,
		)
			? 0
			: 1;
		const rightMatches = selected.sites.some(
			(site) => (site.kind === 'declared' || site.kind === 'default') && site.start === symbolStart && site.end === symbolEnd,
		)
			? 0
			: 1;

		if (
			leftMatches < rightMatches ||
			(leftMatches === rightMatches &&
				(exposureRank(detail.exposure) > exposureRank(selected.exposure) ||
					(exposureRank(detail.exposure) === exposureRank(selected.exposure) &&
						(detail.container.localeCompare(selected.container) < 0 ||
							(detail.container === selected.container &&
								(detail.name.localeCompare(selected.name) < 0 || (detail.name === selected.name && detail.bindingId.localeCompare(selected.bindingId) < 0)))))))
		) {
			selected = detail;
		}
	}

	return selected;
};

const summaryOf = (detail: BindingDetailType): BindingSummaryType => ({
	bindingId: detail.bindingId,
	name: detail.name,
	container: detail.container,
	qualifiedName: detail.qualifiedName,
	exposure: detail.exposure,
	inRequestedContext: detail.inRequestedContext,
});

const emptyDetail = (binding: BindingSummaryType): BindingDetailType => ({
	...binding,
	contexts: [],
	contextsTotal: 0,
	contextsTruncated: false,
	sites: [],
	sitesTotal: 0,
	sitesTruncated: false,
});

const symbolExposureOf = (details: readonly BindingDetailType[]): FindSymbolItemType['symbolExposure'] => {
	const best = details.reduce((selected, detail) => Math.max(selected, exposureRank(detail.exposure)), 0);

	return best === 2 ? 'published' : best === 1 ? 'reachable' : 'internal_only';
};

const reduceItem = (item: FindSymbolItemType, level: number): FindSymbolItemType => {
	if (level === 0) {
		return item;
	}

	if (level === 1) {
		return {...item, otherNames: [], namesTruncated: item.namesTotal > 0};
	}

	const compact = level >= 3;
	const contexts = compact ? [] : item.matched.contexts.slice(0, 1);
	const sites = compact ? [] : item.matched.sites.slice(0, 1);

	return {
		...item,
		contexts: compact ? [] : item.contexts,
		otherNames: [],
		namesTruncated: item.namesTotal > 0,
		matched: {
			...item.matched,
			contexts,
			contextsTruncated: contexts.length < item.matched.contextsTotal,
			sites,
			sitesTruncated: sites.length < item.matched.sitesTotal,
		},
		sites: item.sites.slice(0, 1),
		sitesTruncated: item.sitesTotal > 1,
	};
};

const candidateScore = (candidate: BindingCandidateType): readonly [number, number, number, string, string, string, string, string] => [
	matchRank(candidate.match),
	-exposureRank(candidate.binding.exposure),
	candidate.hasDeclaredSite ? 0 : 1,
	candidate.adapter,
	candidate.binding.container,
	candidate.binding.name,
	candidate.binding.bindingId,
	candidate.symbolId,
];

const compareCandidates = (left: BindingCandidateType, right: BindingCandidateType): number =>
	matchRank(left.match) - matchRank(right.match) ||
	exposureRank(right.binding.exposure) - exposureRank(left.binding.exposure) ||
	(left.hasDeclaredSite ? 0 : 1) - (right.hasDeclaredSite ? 0 : 1) ||
	left.adapter.localeCompare(right.adapter) ||
	left.binding.container.localeCompare(right.binding.container) ||
	left.binding.name.localeCompare(right.binding.name) ||
	left.binding.bindingId.localeCompare(right.binding.bindingId) ||
	left.symbolId.localeCompare(right.symbolId);

const selectBestCandidates = (candidates: readonly BindingCandidateType[]): readonly BindingCandidateType[] => {
	const best = new Map<string, {candidate: BindingCandidateType; score: readonly (number | string)[]}>();

	for (const candidate of candidates) {
		const score = candidateScore(candidate);
		const current = best.get(candidate.symbolId);

		if (current === undefined || compareTuples(score, current.score) < 0) {
			best.set(candidate.symbolId, {candidate, score});
		}
	}

	return [...best.values()].map((entry) => entry.candidate).sort(compareCandidates);
};

const buildSymbolItem = (
	candidate: BindingCandidateType,
	symbol: SymbolSummaryType,
	details: readonly BindingDetailType[],
	sites: FindSymbolItemType['sites'],
): FindSymbolItemType => {
	const matched = details.find((detail) => detail.bindingId === candidate.binding.bindingId) ?? emptyDetail(candidate.binding);
	const primarySite = sites.find((site) => site.primary) ?? sites[0];
	const primary = primaryBindingOf(details, primarySite?.nameStart ?? symbol.startOffset, primarySite?.nameEnd ?? symbol.endOffset) ?? matched;
	const others = details.filter((detail) => detail.bindingId !== matched.bindingId).map((detail) => summaryOf(detail));

	return {
		...symbol,
		symbolId: candidate.symbolId,
		symbolExposure: symbolExposureOf(details),
		match: candidate.match,
		matched,
		primary: summaryOf(primary),
		otherNames: others.slice(0, 5),
		namesTotal: details.length,
		namesTruncated: others.length > 5,
		sites: sites.slice(0, 5),
		sitesTotal: sites.length,
		sitesTruncated: sites.length > 5,
	};
};

const boundedResult = (
	input: Readonly<{
		context: QueryContextType;
		page: readonly FindSymbolItemType[];
		hasMore: boolean;
		offset: number;
		level: number;
		queryKind: string;
		maxResultBytes: number;
		exposure: FindSymbolResultType['exposure'];
		match: FindSymbolResultType['match'];
	}>,
): FindSymbolResultType | null => {
	try {
		return boundedPagedResult({
			generationId: input.context.generationId,
			items: input.page.map((item) => reduceItem(item, input.level)),
			offset: input.offset,
			queryKind: input.queryKind,
			hasMore: input.hasMore,
			maxResultBytes: input.maxResultBytes,
			createResult: (paged) => ({
				generationId: input.context.generationId,
				freshness: input.context.freshness,
				exposure: input.exposure,
				match: input.match,
				items: paged.items,
				nextCursor: paged.nextCursor,
				truncated: paged.truncated,
			}),
		});
	} catch (error) {
		if (error instanceof CodeIndexError && error.code === 'response_too_large') {
			return null;
		}

		throw error;
	}
};

const selectedAdaptersOf = (context: QueryContextType, scope: QueryScopeType): readonly string[] =>
	scope.adapter === undefined ? context.adapters : [scope.adapter];

const loadSymbolCandidates = (
	context: QueryContextType,
	input: FindSymbolInputType,
	scope: QueryScopeType,
	search: Readonly<{
		rawQuery: string;
		match: 'name' | 'qualified';
		exposure: FindSymbolResultType['exposure'];
		normalizedPath: string | undefined;
		offset: number;
	}>,
): readonly BindingCandidateType[] => {
	const fetchLimit = Math.min(10 ** 4, Math.max(10 ** 3, (search.offset + input.limit + 1) * 20));
	const selected = selectedAdaptersOf(context, scope);
	const entries = normalizedQueryEntries({scope, adapters: context.adapters, normalizers: context.normalizers, text: search.rawQuery});
	const groups = groupNormalizedQueries(entries);
	const candidates: BindingCandidateType[] = [];

	for (const group of groups) {
		const unfiltered = scope.adapter === undefined && group.adapters.length === selected.length;
		const adapters = unfiltered ? [undefined] : group.adapters;

		for (const adapter of adapters) {
			candidates.push(
				...context.database.findBindingCandidates({
					generationId: context.generationId,
					query: group.query,
					match: search.match,
					...(input.kind === undefined ? {} : {kind: input.kind}),
					...(input.container === undefined ? {} : {container: input.container}),
					...(search.normalizedPath === undefined ? {} : {path: search.normalizedPath}),
					...(scope.context === undefined ? {} : {context: scope.context}),
					...(adapter === undefined ? {} : {adapter}),
					exposure: search.exposure,
					fetchLimit,
				}),
			);
		}
	}

	return candidates;
};

const presenceBitsOf = (presence: ExactNamePresenceType): string => (presence === 'none' ? '' : presence);

const PRESENCE_BY_BITS: Readonly<Record<string, ExactNamePresenceType>> = {
	none: 'none',
	P: 'P',
	R: 'R',
	I: 'I',
	PR: 'PR',
	PI: 'PI',
	RI: 'RI',
	PRI: 'PRI',
};

const presenceOfBits = (bits: string): ExactNamePresenceType => {
	const ordered = ['P', 'R', 'I'].filter((bit) => bits.includes(bit)).join('');

	return PRESENCE_BY_BITS[ordered] ?? 'none';
};

const recordExactNameOutcome = (
	input: Readonly<{
		context: QueryContextType;
		scope: QueryScopeType;
		request: FindSymbolInputType;
		rawQuery: string;
		match: FindSymbolResultType['match'];
	}>,
): void => {
	const {context, scope, request, rawQuery, match} = input;

	if (rawQuery.length === 0 || match !== 'name' || request.cursor !== undefined || context.exactNameTelemetry === undefined) {
		return;
	}

	const entries = normalizedQueryEntries({scope, adapters: context.adapters, normalizers: context.normalizers, text: rawQuery});
	const bits = entries.reduce((union, entry) => {
		const presence = context.database.exactNamePresence({
			generationId: context.generationId,
			name: entry.query,
			...(scope.context === undefined ? {} : {context: scope.context}),
			adapter: entry.adapter,
		});

		return union + presenceBitsOf(presence);
	}, '');

	context.exactNameTelemetry(presenceOfBits([...new Set(bits)].join('')));
};

/**
 * Rejects an empty search that cannot be satisfied by a container filter.
 *
 * @param rawQuery - Trimmed authored query.
 * @param container - Optional binding container filter.
 * @throws {@link CodeIndexError} When both the query and container are empty.
 */
const assertSearchableQuery = (rawQuery: string, container: string | undefined): void => {
	if (rawQuery.length === 0 && container === undefined) {
		throw new CodeIndexError('invalid_argument', 'Query must not be empty without a container');
	}
};

/**
 * Finds declarations through canonical bindings and deduplicates them by symbol.
 *
 * Candidate bindings are filtered and ranked before pagination. Each item
 * reports its matched binding, global primary binding, remaining bindings, and
 * definition sites.
 *
 * @param context - Database, published generation, adapters, and freshness.
 * @param input - Query text, filters, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated symbol matches.
 * @throws {@link CodeIndexError} When the query is empty, a filter is invalid, or the cursor is invalid.
 */
export const findSymbols = (context: QueryContextType, input: FindSymbolInputType, maxResultBytes: number): FindSymbolResultType => {
	const rawQuery = input.query.trim();
	const match = input.match ?? 'name';
	const exposure = input.exposure ?? 'visible';

	assertSearchableQuery(rawQuery, input.container);

	const normalizedPath = input.path === undefined ? undefined : normalizeRelativePath(input.path);
	const scope = resolveQueryScope({
		database: context.database,
		generationId: context.generationId,
		adapters: context.adapters,
		normalizers: context.normalizers,
		...(input.adapter === undefined ? {} : {adapter: input.adapter}),
		...(input.context === undefined ? {} : {context: input.context}),
	});
	recordExactNameOutcome({context, scope, request: input, rawQuery, match});
	const queryKind = JSON.stringify([
		'find_symbol',
		match,
		exposure,
		input.kind ?? null,
		input.container ?? null,
		normalizedPath ?? null,
		scope.adapter ?? null,
		scope.context ?? null,
	]);
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const candidates = loadSymbolCandidates(context, input, scope, {rawQuery, match, exposure, normalizedPath, offset});
	const ordered = selectBestCandidates(candidates);
	const pageCandidates = ordered.slice(offset, offset + input.limit);
	const symbolIds = pageCandidates.map((candidate) => candidate.symbolId);
	const summaries = context.database.symbolSummaries(context.generationId, symbolIds);
	const detailsBySymbol = context.database.bindingDetails({
		generationId: context.generationId,
		symbolIds,
		...(scope.context === undefined ? {} : {context: scope.context}),
	});
	const definitionsBySymbol = context.database.definitionSites({generationId: context.generationId, symbolIds});
	const page = pageCandidates.map((candidate) => {
		const symbol = summaries.get(candidate.symbolId);

		if (symbol === undefined) {
			throw new Error(`Published symbol is missing: ${candidate.symbolId}`);
		}

		return buildSymbolItem(candidate, symbol, detailsBySymbol.get(candidate.symbolId) ?? [], definitionsBySymbol.get(candidate.symbolId) ?? []);
	});
	const hasMore = ordered.length > offset + page.length;

	for (let level = 0; level < 4; level += 1) {
		const result = boundedResult({
			context,
			page,
			hasMore,
			offset,
			level,
			queryKind,
			maxResultBytes,
			exposure,
			match,
		});

		if (result !== null) {
			return result;
		}
	}

	throw new CodeIndexError('response_too_large', 'One symbol result item exceeds the configured response bound');
};

export {findReferences} from './referenceQuery.ts';

export {findDependencies} from './dependencyService.ts';
