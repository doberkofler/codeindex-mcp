import {type IndexDatabase} from '../storage/database.ts';
import {findDependencyConsumers, toDependencyConsumers, toDependencyEvidenceConsumers, type DependencyConsumerMatchType} from './dependencyQuery.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {
	type FindDependenciesInputType,
	type FindDependenciesResultType,
	type FindReferencesInputType,
	type FindReferencesResultType,
	type FindSymbolInputType,
	type FindSymbolResultType,
	type QueryFreshnessType,
} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath} from './querySupport.ts';

export type QueryContextType = Readonly<{
	readonly database: IndexDatabase;
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
}>;

/**
 * Finds declarations by exact or prefix name.
 *
 * @param context - Database, published generation, and freshness.
 * @param input - Query text and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated symbol matches.
 * @throws {@link CodeIndexError} When the query is empty or the cursor is invalid.
 */
export const findSymbols = (context: QueryContextType, input: FindSymbolInputType, maxResultBytes: number): FindSymbolResultType => {
	const query = input.query.trim();

	if (query.length === 0) {
		throw new CodeIndexError('invalid_argument', 'Query must not be empty');
	}

	const offset = decodeCursor(input.cursor, context.generationId, 'find_symbol').o;
	const rows = context.database.findSymbols(context.generationId, query, input.limit + 1, offset);
	const items = rows.slice(0, input.limit);

	return boundedPagedResult({
		generationId: context.generationId,
		items,
		offset,
		queryKind: 'find_symbol',
		hasMore: rows.length > items.length,
		maxResultBytes,
		createResult: (page) => ({generationId: context.generationId, freshness: context.freshness, ...page}),
	});
};

/**
 * Finds stored occurrences for one symbol.
 *
 * @param context - Database, published generation, and freshness.
 * @param input - Symbol, optional role, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated definition and reference occurrences.
 * @throws {@link CodeIndexError} When the symbol is unknown or the cursor is invalid.
 */
export const findReferences = (context: QueryContextType, input: FindReferencesInputType, maxResultBytes: number): FindReferencesResultType => {
	if (context.database.getSymbol(context.generationId, input.symbolId) === null) {
		throw new CodeIndexError('symbol_not_found', `Unknown symbol: ${input.symbolId}`);
	}

	const offset = decodeCursor(input.cursor, context.generationId, 'find_references').o;
	const rows = context.database.findReferences({
		generationId: context.generationId,
		symbolId: input.symbolId,
		role: input.role,
		limit: input.limit + 1,
		offset,
	});
	const items = rows.slice(0, input.limit);

	return boundedPagedResult({
		generationId: context.generationId,
		items,
		offset,
		queryKind: 'find_references',
		hasMore: rows.length > items.length,
		maxResultBytes,
		createResult: (page) => ({generationId: context.generationId, freshness: context.freshness, ...page}),
	});
};

/**
 * Builds complete-set dependency counts, independent of the returned page.
 *
 * @param matches - Every consumer match for the query.
 * @param transitive - Whether the query is module impact.
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
 * Finds authored modules that consume one normalized npm package.
 *
 * Direct usage (`transitive: false`, the default) contains modules with a
 * package edge. Module impact (`transitive: true`) traverses authored imports
 * and groups every shortest path by the direct consumer that starts it.
 *
 * @param context - Database, published generation, and freshness.
 * @param input - Package, traversal mode, optional root, detail level, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated dependency consumers with complete-set counts.
 * @throws {@link CodeIndexError} When the package is empty, a root is invalid, or the cursor is invalid.
 */
export const findDependencies = (context: QueryContextType, input: FindDependenciesInputType, maxResultBytes: number): FindDependenciesResultType => {
	const packageName = input.package.trim();

	if (packageName.length === 0) {
		throw new CodeIndexError('invalid_argument', 'Package must not be empty');
	}

	const transitive = input.transitive ?? false;
	const detail = input.detail ?? 'compact';
	const direction = input.direction ?? 'consumers';
	const root = input.root === undefined ? undefined : normalizeRelativePath(input.root);

	if (root !== undefined && !transitive) {
		throw new CodeIndexError('invalid_argument', 'root requires transitive: true');
	}

	const queryKind = JSON.stringify(['find_dependencies', direction, transitive ? 'impact' : 'direct', detail, packageName, root ?? null]);
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const matches = findDependencyConsumers({
		database: context.database,
		generationId: context.generationId,
		packageName,
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
	const queryMeaning = transitive ? 'module_impact' : 'direct_usage';

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
