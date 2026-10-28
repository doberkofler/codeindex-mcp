import {type IndexDatabase} from '../storage/database.ts';
import {findDependencyConsumers, toDependencyConsumers, toDependencyEvidenceConsumers, type DependencyConsumerMatchType} from './dependencyQuery.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {
	type BindingDetailType,
	type BindingSummaryType,
	type FindDependenciesInputType,
	type FindDependenciesResultType,
	type ExactNamePresenceType,
	type FindSymbolInputType,
	type FindSymbolItemType,
	type FindSymbolResultType,
	type QueryFreshnessType,
	type SymbolSummaryType,
} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath} from './querySupport.ts';
import {type BindingCandidateType} from '../storage/databasePublicationQueries.ts';

export type QueryContextType = Readonly<{
	readonly database: IndexDatabase;
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	/** Optional local analytics sink for exact-name presence outcomes. */
	readonly exactNameTelemetry?: ((presence: ExactNamePresenceType) => void) | undefined;
}>;

export const assertKnownContext = (context: QueryContextType, requested: string | undefined): void => {
	if (requested === undefined) {
		return;
	}

	const known = context.database.listProjectContextNames(context.generationId);

	if (!known.includes(requested)) {
		throw new CodeIndexError('invalid_argument', `Unknown project context: ${requested}. Available contexts: ${known.join(', ')}`);
	}
};

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

const candidateScore = (candidate: BindingCandidateType): readonly [number, number, number, string, string, string, string] => [
	matchRank(candidate.match),
	-exposureRank(candidate.binding.exposure),
	candidate.hasDeclaredSite ? 0 : 1,
	candidate.binding.container,
	candidate.binding.name,
	candidate.binding.bindingId,
	candidate.symbolId,
];

const compareCandidates = (left: BindingCandidateType, right: BindingCandidateType): number =>
	matchRank(left.match) - matchRank(right.match) ||
	exposureRank(right.binding.exposure) - exposureRank(left.binding.exposure) ||
	(left.hasDeclaredSite ? 0 : 1) - (right.hasDeclaredSite ? 0 : 1) ||
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

const loadSymbolCandidates = (
	context: QueryContextType,
	input: FindSymbolInputType,
	search: Readonly<{
		query: string;
		match: 'name' | 'qualified';
		exposure: FindSymbolResultType['exposure'];
		normalizedPath: string | undefined;
		offset: number;
	}>,
): readonly BindingCandidateType[] => {
	const fetchLimit = Math.min(10 ** 4, Math.max(10 ** 3, (search.offset + input.limit + 1) * 20));

	return context.database.findBindingCandidates({
		generationId: context.generationId,
		query: search.query,
		match: search.match,
		...(input.kind === undefined ? {} : {kind: input.kind}),
		...(input.container === undefined ? {} : {container: input.container}),
		...(search.normalizedPath === undefined ? {} : {path: search.normalizedPath}),
		...(input.context === undefined ? {} : {context: input.context}),
		exposure: search.exposure,
		fetchLimit,
	});
};

const recordExactNameOutcome = (context: QueryContextType, input: FindSymbolInputType, query: string, match: FindSymbolResultType['match']): void => {
	if (query.length === 0 || match !== 'name' || input.cursor !== undefined || context.exactNameTelemetry === undefined) {
		return;
	}

	context.exactNameTelemetry(context.database.exactNamePresence({generationId: context.generationId, name: query, context: input.context}));
};

/**
 * Finds declarations through canonical bindings and deduplicates them by symbol.
 *
 * Candidate bindings are filtered and ranked before pagination. Each item
 * reports its matched binding, global primary binding, remaining bindings, and
 * definition sites.
 *
 * @param context - Database, published generation, and freshness.
 * @param input - Query text, filters, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated symbol matches.
 * @throws {@link CodeIndexError} When the query is empty, a filter is invalid, or the cursor is invalid.
 */
export const findSymbols = (context: QueryContextType, input: FindSymbolInputType, maxResultBytes: number): FindSymbolResultType => {
	const query = input.query.trim();
	const match = input.match ?? 'name';
	const exposure = input.exposure ?? 'visible';

	if (query.length === 0 && input.container === undefined) {
		throw new CodeIndexError('invalid_argument', 'Query must not be empty without a container');
	}

	const normalizedPath = input.path === undefined ? undefined : normalizeRelativePath(input.path);
	assertKnownContext(context, input.context);
	recordExactNameOutcome(context, input, query, match);
	const queryKind = JSON.stringify([
		'find_symbol',
		match,
		exposure,
		input.kind ?? null,
		input.container ?? null,
		normalizedPath ?? null,
		input.context ?? null,
	]);
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const candidates = loadSymbolCandidates(context, input, {query, match, exposure, normalizedPath, offset});
	const ordered = selectBestCandidates(candidates);
	const pageCandidates = ordered.slice(offset, offset + input.limit);
	const symbolIds = pageCandidates.map((candidate) => candidate.symbolId);
	const summaries = context.database.symbolSummaries(context.generationId, symbolIds);
	const detailsBySymbol = context.database.bindingDetails({
		generationId: context.generationId,
		symbolIds,
		...(input.context === undefined ? {} : {context: input.context}),
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

/**
 * Builds complete-set dependency counts, independent of the returned page.
 *
 * @param matches - Every consumer match for the query.
 * @param transitive - Whether the query is dependency impact.
 * @returns Unique totals and, for impact, per-root group counts.
 */
const summarizeDependencyMatches = (matches: readonly DependencyConsumerMatchType[], transitive: boolean): FindDependenciesResultType['summary'] => {
	const uniquePaths = new Set<string>();
	const directPaths = new Set<string>();
	const rootCounts = new Map<string, number>();

	for (const match of matches) {
		uniquePaths.add(match.path);

		if (match.depth === 1) {
			directPaths.add(match.path);
		}

		rootCounts.set(match.directRoot, (rootCounts.get(match.directRoot) ?? 0) + 1);
	}

	const roots = transitive
		? [...rootCounts.entries()].map(([path, consumerCount]) => ({path, consumerCount})).sort((left, right) => left.path.localeCompare(right.path))
		: [];

	return {
		totalConsumers: uniquePaths.size,
		directConsumers: directPaths.size,
		transitiveConsumers: uniquePaths.size - directPaths.size,
		roots,
	};
};

/**
 * Finds authored modules that consume one canonical external or logical target.
 *
 * Direct usage (`transitive: false`, the default) contains modules with an edge
 * to the exact target identifier. Dependency impact (`transitive: true`)
 * traverses authored module targets and groups every shortest path by the
 * direct consumer that starts it.
 *
 * @param context - Database, published generation, and freshness.
 * @param input - Target identifier, traversal mode, optional root, detail level, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated dependency consumers with complete-set counts.
 * @throws {@link CodeIndexError} When the target is empty, a root is invalid, or the cursor is invalid.
 */
export const findDependencies = (context: QueryContextType, input: FindDependenciesInputType, maxResultBytes: number): FindDependenciesResultType => {
	const targetIdentifier = input.target.trim();

	if (targetIdentifier.length === 0) {
		throw new CodeIndexError('invalid_argument', 'Target must not be empty');
	}

	const transitive = input.transitive ?? false;
	const detail = input.detail ?? 'compact';
	const direction = input.direction ?? 'consumers';
	const root = input.root === undefined ? undefined : normalizeRelativePath(input.root);

	if (root !== undefined && !transitive) {
		throw new CodeIndexError('invalid_argument', 'root requires transitive: true');
	}

	assertKnownContext(context, input.context);
	const queryKind = JSON.stringify([
		'find_dependencies',
		direction,
		transitive ? 'impact' : 'direct',
		detail,
		targetIdentifier,
		root ?? null,
		input.context ?? null,
	]);
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const matches = findDependencyConsumers({
		database: context.database,
		generationId: context.generationId,
		targetIdentifier,
		context: input.context,
		transitive,
		root,
	});
	const pageMatches = matches.slice(offset, offset + input.limit);
	const items =
		detail === 'evidence'
			? toDependencyEvidenceConsumers(
					pageMatches,
					context.database.listDependencyBindings(
						context.generationId,
						pageMatches.map((match) => match.edge.id),
					),
				)
			: toDependencyConsumers(pageMatches);
	const summary = summarizeDependencyMatches(matches, transitive);
	const queryMeaning = transitive ? 'dependency_impact' : 'direct_usage';

	return boundedPagedResult({
		generationId: context.generationId,
		items,
		offset,
		queryKind,
		hasMore: matches.length > offset + pageMatches.length,
		maxResultBytes,
		createResult: (page) => ({
			generationId: context.generationId,
			freshness: context.freshness,
			queryMeaning,
			summary,
			items: page.items,
			nextCursor: page.nextCursor,
			truncated: page.truncated,
		}),
	});
};
