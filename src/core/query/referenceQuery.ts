import {type IndexDatabase} from '../storage/database.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {type FindReferencesInputType, type FindReferencesResultType, type QueryFreshnessType} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath} from './querySupport.ts';

type QueryContextType = Readonly<{database: IndexDatabase; generationId: string; freshness: QueryFreshnessType}>;

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
 * Finds stored occurrences for one symbol.
 *
 * @param context - Database, published generation, and freshness.
 * @param input - Symbol, filters, and page bounds.
 * @param maxResultBytes - Maximum serialized result-data size.
 * @returns Paginated definition and reference occurrences.
 * @throws {@link CodeIndexError} When the symbol is unknown, a usage filter conflicts with definitions, or the cursor is invalid.
 */
export const findReferences = (context: QueryContextType, input: FindReferencesInputType, maxResultBytes: number): FindReferencesResultType => {
	if (context.database.getSymbol(context.generationId, input.symbolId) === null) {
		throw new CodeIndexError('symbol_not_found', `Unknown symbol: ${input.symbolId}`);
	}

	if (input.usage !== undefined && input.role === 'definition') {
		throw new CodeIndexError('invalid_argument', 'usage filtering is not valid with role: definition');
	}

	const normalizedPath = input.path === undefined ? undefined : normalizeRelativePath(input.path);
	assertKnownContext(context, input.context);
	const queryKind = JSON.stringify([
		'find_references',
		input.symbolId,
		input.role ?? null,
		normalizedPath ?? null,
		input.enclosingId ?? null,
		input.usage ?? null,
		input.context ?? null,
	]);
	const offset = decodeCursor(input.cursor, context.generationId, queryKind).o;
	const rows = context.database.findReferenceRows({
		generationId: context.generationId,
		symbolId: input.symbolId,
		role: input.role,
		path: normalizedPath,
		enclosingId: input.enclosingId,
		usage: input.usage,
		context: input.context,
		limit: input.limit,
		offset,
	});
	const items = rows.slice(0, input.limit);
	const coverage = context.database.referenceCoverage({
		generationId: context.generationId,
		symbolId: input.symbolId,
		filters: {...input, path: normalizedPath},
	});

	return boundedPagedResult({
		generationId: context.generationId,
		items,
		offset,
		queryKind,
		hasMore: rows.length > items.length,
		maxResultBytes,
		createResult: (page) => ({
			generationId: context.generationId,
			freshness: context.freshness,
			unclassifiedReferences: coverage.unclassifiedReferences,
			crossFileRefsObserved: coverage.crossFileRefsObserved,
			items: page.items,
			nextCursor: page.nextCursor,
			truncated: page.truncated,
		}),
	});
};
