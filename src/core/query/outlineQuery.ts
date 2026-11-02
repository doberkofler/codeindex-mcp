import {type OutlineInputType, type OutlineResultType, type QueryFreshnessType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath} from './querySupport.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {assertPathAdapter} from './queryScope.ts';

/**
 * Requires an explicit adapter to be configured and to own the path.
 *
 * @param input - Database, generation, configured adapters, path, and requested adapter.
 * @throws {@link CodeIndexError} When the adapter is unknown or another adapter owns the path.
 */
const assertOutlineAdapter = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		adapters: readonly string[];
		path: string;
		adapter: string | undefined;
	}>,
): void => {
	if (input.adapter !== undefined && !input.adapters.includes(input.adapter)) {
		throw new CodeIndexError('unknown_adapter', `Unknown adapter: ${input.adapter}`);
	}

	if (input.adapter !== undefined) {
		assertPathAdapter({adapter: input.adapter, owner: input.database.fileAdapter(input.generationId, input.path), path: input.path});
	}
};

/**
 * Builds one bounded lexical outline page and its re-export list.
 *
 * @param input - Published generation, freshness, path filters, and page bounds.
 * @returns Paginated outline items with a bounded re-export list.
 * @throws {@link CodeIndexError} When the path is unknown, the adapter does not
 * own the path, or the cursor is invalid.
 */
export const queryOutline = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		freshness: QueryFreshnessType;
		adapters: readonly string[];
		input: OutlineInputType;
		maxResultBytes: number;
	}>,
): OutlineResultType => {
	const pathName = normalizeRelativePath(input.input.path);
	const kinds = input.input.kinds ?? [];

	assertOutlineAdapter({
		database: input.database,
		generationId: input.generationId,
		adapters: input.adapters,
		path: pathName,
		adapter: input.input.adapter,
	});

	const queryKind = JSON.stringify(['outline', pathName, kinds, input.input.adapter ?? null]);
	const offset = decodeCursor(input.input.cursor, input.generationId, queryKind).o;
	const rows = input.database.outlineSymbols({
		generationId: input.generationId,
		path: pathName,
		kinds,
		limit: input.input.limit + 1,
		offset,
	});

	if (offset === 0 && rows.length === 0 && input.database.getFile(input.generationId, pathName) === null) {
		throw new CodeIndexError('file_not_indexed', `File is not in the published index: ${pathName}`);
	}

	const items = rows.slice(0, input.input.limit);
	const allReexports = input.database.outlineReexports(input.generationId, pathName);
	const reexports = allReexports.slice(0, 10);

	return boundedPagedResult({
		generationId: input.generationId,
		items,
		offset,
		queryKind,
		hasMore: rows.length > items.length,
		maxResultBytes: input.maxResultBytes,
		createResult: (page) => ({
			generationId: input.generationId,
			freshness: input.freshness,
			items: page.items.map((row) => ({...row.symbol, site: row.site})),
			nextCursor: page.nextCursor,
			truncated: page.truncated,
			reexports,
			reexportsTotal: allReexports.length,
			reexportsTruncated: allReexports.length > reexports.length,
		}),
	});
};
