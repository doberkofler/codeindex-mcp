import {type IndexDatabase} from '../storage/database.ts';
import {type ReferenceScopeType} from '../storage/databaseReferenceQueries.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {
	type FindReferencesInputType,
	type FindReferencesResultType,
	type QueryFreshnessType,
	type ReferenceGroupModeType,
	type ReferenceGroupType,
	type ReferenceOwnerGroupType,
} from '../model.ts';

type QueryContextType = Readonly<{database: IndexDatabase; generationId: string; freshness: QueryFreshnessType}>;

type GroupAccumulatorType = Readonly<{
	path: string;
	owner: ReferenceOwnerGroupType['owner'];
	count: number;
	usage: number;
	contexts: readonly string[];
}>;

const MAX_GROUP_CONTEXTS = 8;
const USAGE_BITS = [1, 2, 4, 8] as const;

const compareText = (left: string, right: string): number => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

const hasUsageBit = (value: number, bit: number): boolean => Math.floor(value / bit) % 2 === 1;

/**
 * Unions usage masks without relying on a bitwise operator.
 *
 * @param left - First usage mask.
 * @param right - Second usage mask.
 * @returns The union of both masks.
 */
const unionUsage = (left: number, right: number): number =>
	USAGE_BITS.reduce((mask, bit) => (hasUsageBit(left, bit) || hasUsageBit(right, bit) ? mask + bit : mask), 0);

const groupKeyOf = (group: ReferenceGroupModeType, pathName: string, ownerId: string | null): string =>
	group === 'owner' ? `${pathName}\u0000${ownerId ?? ''}` : pathName;

const groupContexts = (group: ReferenceGroupModeType, rows: ReturnType<IndexDatabase['referenceGroupContexts']>): ReadonlyMap<string, readonly string[]> => {
	const contexts = new Map<string, string[]>();

	for (const row of rows) {
		const key = groupKeyOf(group, row.path, row.enclosingId);
		const names = contexts.get(key) ?? [];

		if (!names.includes(row.contextName)) {
			names.push(row.contextName);
			contexts.set(key, names);
		}
	}

	return contexts;
};

/**
 * Builds ordered file or owner groups from one filtered occurrence scope.
 *
 * @param context - Database and published generation.
 * @param scope - Symbol and occurrence filters.
 * @param group - File or owner grouping.
 * @returns Groups ordered by path and, for owner groups, null owner first.
 */
const groupAccumulators = (context: QueryContextType, scope: ReferenceScopeType, group: ReferenceGroupModeType): readonly GroupAccumulatorType[] => {
	const contexts = groupContexts(group, context.database.referenceGroupContexts(scope));
	const groups = new Map<string, {path: string; owner: ReferenceOwnerGroupType['owner']; count: number; usage: number}>();

	for (const row of context.database.referenceGroupRows(scope)) {
		const key = groupKeyOf(group, row.path, row.owner?.symbolId ?? null);
		const current = groups.get(key);

		if (current === undefined) {
			groups.set(key, {path: row.path, owner: group === 'owner' ? row.owner : null, count: row.count, usage: row.usage});
		} else {
			current.count += row.count;
			current.usage = unionUsage(current.usage, row.usage);
		}
	}

	return [...groups.entries()]
		.map(([key, value]) => ({...value, contexts: contexts.get(key) ?? []}))
		.sort((left, right) => {
			const pathOrder = compareText(left.path, right.path);

			if (pathOrder !== 0 || group !== 'owner') {
				return pathOrder;
			}

			if (left.owner === null) {
				return right.owner === null ? 0 : -1;
			}

			if (right.owner === null) {
				return 1;
			}

			return compareText(left.owner.symbolId, right.owner.symbolId);
		});
};

const groupBaseOf = (groupValue: GroupAccumulatorType, includeContexts: boolean): ReferenceGroupType => ({
	path: groupValue.path,
	count: groupValue.count,
	usage: groupValue.usage,
	contexts: includeContexts ? groupValue.contexts.slice(0, MAX_GROUP_CONTEXTS) : [],
	contextsTruncated: groupValue.contexts.length > (includeContexts ? MAX_GROUP_CONTEXTS : 0),
});

const ownerGroupItemOf = (groupValue: GroupAccumulatorType, includeContexts: boolean): ReferenceOwnerGroupType => ({
	...groupBaseOf(groupValue, includeContexts),
	owner: groupValue.owner,
});

const resultForGroup = (
	input: Readonly<{
		generationId: string;
		freshness: QueryFreshnessType;
		selector: 'symbolId' | 'query';
		group: 'file' | 'owner';
		groupsTotal: number;
		page: readonly GroupAccumulatorType[];
		count: number;
		includeContexts: boolean;
		offset: number;
		queryKind: string;
		hasMore: boolean;
		coverage: ReturnType<IndexDatabase['referenceCoverage']>;
		totals: ReturnType<IndexDatabase['referenceTotals']>;
	}>,
): FindReferencesResultType => {
	const truncated = input.hasMore || input.count < input.page.length;
	const nextCursor = truncated
		? Buffer.from(JSON.stringify({g: input.generationId, q: input.queryKind, o: input.offset + input.count}), 'utf8').toString('base64url')
		: null;
	const common = {
		generationId: input.generationId,
		freshness: input.freshness,
		selector: input.selector,
		groupsTotal: input.groupsTotal,
		occurrencesTotal: input.totals.occurrencesTotal,
		definitionsTotal: input.totals.definitionsTotal,
		unclassifiedReferences: input.coverage.unclassifiedReferences,
		crossFileRefsObserved: input.coverage.crossFileRefsObserved,
		nextCursor,
		truncated,
	} as const;

	return input.group === 'file'
		? {
				...common,
				kind: 'files',
				group: 'file',
				items: input.page.slice(0, input.count).map((groupValue) => groupBaseOf(groupValue, input.includeContexts)),
			}
		: {
				...common,
				kind: 'owners',
				group: 'owner',
				items: input.page.slice(0, input.count).map((groupValue) => ownerGroupItemOf(groupValue, input.includeContexts)),
			};
};

const boundedGroupPage = (
	input: Readonly<{
		generationId: string;
		freshness: QueryFreshnessType;
		selector: 'symbolId' | 'query';
		group: 'file' | 'owner';
		groups: readonly GroupAccumulatorType[];
		offset: number;
		limit: number;
		queryKind: string;
		maxResultBytes: number;
		coverage: ReturnType<IndexDatabase['referenceCoverage']>;
		totals: ReturnType<IndexDatabase['referenceTotals']>;
	}>,
): FindReferencesResultType => {
	const page = input.groups.slice(input.offset, input.offset + input.limit);
	const hasMore = input.groups.length > input.offset + page.length;
	const resultFor = (count: number, includeContexts: boolean): FindReferencesResultType =>
		resultForGroup({
			...input,
			groupsTotal: input.groups.length,
			page,
			count,
			includeContexts,
			hasMore,
		});
	const fits = (result: FindReferencesResultType): boolean => Buffer.byteLength(JSON.stringify(result), 'utf8') <= input.maxResultBytes;

	if (page.length === 0) {
		return resultFor(0, true);
	}

	const full = resultFor(page.length, true);

	if (fits(full)) {
		return full;
	}

	// Cursor growth is not monotonic with item count, so test the complete
	// context-free page before dropping trailing groups.
	const contextFree = resultFor(page.length, false);

	if (fits(contextFree)) {
		return contextFree;
	}

	for (let count = page.length - 1; count >= 1; count -= 1) {
		const candidate = resultFor(count, false);

		if (fits(candidate)) {
			return candidate;
		}
	}

	throw new CodeIndexError('response_too_large', `One reference group item exceeds ${input.maxResultBytes} bytes`);
};

/**
 * Builds one byte-bounded file or owner result page.
 *
 * Context names are dropped before trailing groups, and group totals,
 * occurrence totals, definition totals, and coverage counters remain visible.
 *
 * @param input - Query context, selector, filters, grouping, and page bounds.
 * @returns File or owner groups with totals and a continuation cursor.
 * @throws {@link CodeIndexError} When one group cannot fit the byte bound.
 */
export const groupedResultOf = (
	input: Readonly<{
		context: QueryContextType;
		query: FindReferencesInputType;
		scope: ReferenceScopeType;
		selector: 'symbolId' | 'query';
		group: 'file' | 'owner';
		queryKind: string;
		offset: number;
		maxResultBytes: number;
	}>,
): FindReferencesResultType => {
	const coverage = input.context.database.referenceCoverage({
		generationId: input.context.generationId,
		symbolId: input.scope.symbolId,
		filters: input.scope,
	});
	const totals = input.context.database.referenceTotals({
		generationId: input.context.generationId,
		symbolId: input.scope.symbolId,
		filters: input.scope,
	});

	return boundedGroupPage({
		generationId: input.context.generationId,
		freshness: input.context.freshness,
		selector: input.selector,
		group: input.group,
		groups: groupAccumulators(input.context, input.scope, input.group),
		offset: input.offset,
		limit: input.query.limit,
		queryKind: input.queryKind,
		maxResultBytes: input.maxResultBytes,
		coverage,
		totals,
	});
};
