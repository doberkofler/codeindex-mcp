import {findDependencyConsumers, toDependencyConsumers, toDependencyEvidenceConsumers, type DependencyConsumerMatchType} from './dependencyQuery.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {type FindDependenciesInputType, type FindDependenciesResultType} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath} from './querySupport.ts';
import {resolveQueryScope} from './queryScope.ts';
import {type QueryContextType} from './queryService.ts';

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
 * Rejects dependency queries that cannot be evaluated.
 *
 * @param targetIdentifier - Trimmed canonical target.
 * @param transitive - Whether the query is dependency impact.
 * @param root - Optional direct consumer root.
 * @throws {@link CodeIndexError} When the target is empty or root is invalid.
 */
const assertDependencyQuery = (targetIdentifier: string, transitive: boolean, root: string | undefined): void => {
	if (targetIdentifier.length === 0) {
		throw new CodeIndexError('invalid_argument', 'Target must not be empty');
	}

	if (root !== undefined && !transitive) {
		throw new CodeIndexError('invalid_argument', 'root requires transitive: true');
	}
};

/**
 * Finds authored modules that consume one canonical external or logical target.
 *
 * Direct usage (`transitive: false`, the default) contains modules with an edge
 * to the exact target identifier. Dependency impact (`transitive: true`)
 * traverses authored module targets and groups every shortest path by the
 * direct consumer that starts it.
 *
 * @param context - Database, published generation, adapters, and freshness.
 * @param input - Target identifier, traversal mode, optional root, detail level, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated dependency consumers with complete-set counts.
 * @throws {@link CodeIndexError} When the target is empty, a root is invalid, or the cursor is invalid.
 */
export const findDependencies = (context: QueryContextType, input: FindDependenciesInputType, maxResultBytes: number): FindDependenciesResultType => {
	const targetIdentifier = input.target.trim();
	const transitive = input.transitive ?? false;
	const detail = input.detail ?? 'compact';
	const direction = input.direction ?? 'consumers';
	const root = input.root === undefined ? undefined : normalizeRelativePath(input.root);

	assertDependencyQuery(targetIdentifier, transitive, root);

	const scope = resolveQueryScope({
		database: context.database,
		generationId: context.generationId,
		adapters: context.adapters,
		normalizers: context.normalizers,
		...(input.adapter === undefined ? {} : {adapter: input.adapter}),
		...(input.context === undefined ? {} : {context: input.context}),
	});
	const queryKind = JSON.stringify([
		'find_dependencies',
		direction,
		transitive ? 'impact' : 'direct',
		detail,
		targetIdentifier,
		root ?? null,
		scope.adapter ?? null,
		scope.context ?? null,
	]);
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const matches = findDependencyConsumers({
		database: context.database,
		generationId: context.generationId,
		targetIdentifier,
		...(scope.context === undefined ? {} : {context: scope.context}),
		...(scope.adapter === undefined ? {} : {adapter: scope.adapter}),
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
