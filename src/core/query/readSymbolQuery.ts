import {readFileSync} from 'node:fs';
import path from 'node:path';
import {type QueryFreshnessType, type ReadSymbolInputType, type ReadSymbolResultType, type SymbolSummaryType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {CodeIndexError, StaleFileError} from '../errors/errors.ts';
import {hashContent} from '../generation/sourceFiles.ts';
import {boundedPagedResult, decodeCursor} from './querySupport.ts';
import {readSymbolResult} from './readSymbolResult.ts';

const {resolve, sep} = path;

type ReadQueryInputType = Readonly<{
	database: IndexDatabase;
	rootDir: string;
	generationId: string;
	freshness: QueryFreshnessType;
	symbol: SymbolSummaryType;
	isPathDirty: (pathName: string) => boolean;
	maxReadLines: number;
	maxResultBytes: number;
}>;

const pageResult = <ItemType, ResultType>(
	query: ReadQueryInputType,
	input: Readonly<{
		items: readonly ItemType[];
		offset: number;
		limit: number;
		queryKind: string;
		createResult: (page: {items: readonly ItemType[]; nextCursor: string | null; truncated: boolean}) => ResultType;
	}>,
): ResultType =>
	boundedPagedResult({
		generationId: query.generationId,
		items: input.items.slice(input.offset, input.offset + input.limit),
		offset: input.offset,
		queryKind: input.queryKind,
		hasMore: input.items.length > input.offset + input.limit,
		maxResultBytes: query.maxResultBytes,
		createResult: input.createResult,
	});

const readList = (
	query: ReadQueryInputType,
	input: ReadSymbolInputType,
	mode: 'sites' | 'names' | 'binding_sites' | 'binding_contexts',
): ReadSymbolResultType => {
	const limit = input.limit ?? 50;
	const queryKind = JSON.stringify([mode, query.symbol.id, input.bindingId ?? null, input.context ?? null]);
	const offset = decodeCursor(input.cursor, query.generationId, queryKind).o;

	if (mode === 'sites') {
		return pageResult(query, {
			items: query.database.definitionSitesForSymbol(query.generationId, query.symbol.id),
			offset,
			limit,
			queryKind,
			createResult: (page) => ({
				kind: 'sites',
				generationId: query.generationId,
				freshness: query.freshness,
				items: page.items,
				nextCursor: page.nextCursor,
				truncated: page.truncated,
			}),
		});
	}

	if (mode === 'names') {
		const details =
			query.database
				.bindingDetails({generationId: query.generationId, symbolIds: [query.symbol.id], ...(input.context === undefined ? {} : {context: input.context})})
				.get(query.symbol.id) ?? [];

		return pageResult(query, {
			items: details.map((detail) => ({
				bindingId: detail.bindingId,
				name: detail.name,
				container: detail.container,
				qualifiedName: detail.qualifiedName,
				exposure: detail.exposure,
				inRequestedContext: detail.inRequestedContext,
			})),
			offset,
			limit,
			queryKind,
			createResult: (page) => ({
				kind: 'names',
				generationId: query.generationId,
				freshness: query.freshness,
				items: page.items,
				nextCursor: page.nextCursor,
				truncated: page.truncated,
			}),
		});
	}

	const {bindingId} = input;

	if (bindingId === undefined) {
		throw new CodeIndexError('invalid_argument', `${mode} requires bindingId`);
	}

	if (!query.database.bindingBelongsToSymbol(query.generationId, query.symbol.id, bindingId)) {
		throw new CodeIndexError('invalid_argument', `Binding does not belong to symbol ${query.symbol.id}`);
	}

	if (mode === 'binding_sites') {
		return pageResult(query, {
			items: query.database.bindingSites(query.generationId, [bindingId]).get(bindingId) ?? [],
			offset,
			limit,
			queryKind,
			createResult: (page) => ({
				kind: 'binding_sites',
				bindingId,
				generationId: query.generationId,
				freshness: query.freshness,
				items: page.items,
				nextCursor: page.nextCursor,
				truncated: page.truncated,
			}),
		});
	}

	return pageResult(query, {
		items: query.database.bindingContexts(query.generationId, [bindingId]).get(bindingId) ?? [],
		offset,
		limit,
		queryKind,
		createResult: (page) => ({
			kind: 'binding_contexts',
			bindingId,
			generationId: query.generationId,
			freshness: query.freshness,
			items: page.items,
			nextCursor: page.nextCursor,
			truncated: page.truncated,
		}),
	});
};

/**
 * Reads bounded source or one bounded binding/definition list for a symbol.
 *
 * @param query - Published generation, symbol, file access, freshness, and bounds.
 * @param input - Selector, mode, context, and page bounds.
 * @returns A discriminated text or list result.
 * @throws {@link CodeIndexError} When a selector is invalid.
 * @throws {@link StaleFileError} When source changed or is pending a rebuild.
 */
export const queryReadSymbol = (query: ReadQueryInputType, input: ReadSymbolInputType): ReadSymbolResultType => {
	const mode = input.mode ?? 'text';

	if (mode !== 'text') {
		return readList(query, input, mode);
	}

	const sites = query.database.definitionSitesForSymbol(query.generationId, query.symbol.id);
	const site = input.siteId === undefined ? (sites.find((entry) => entry.primary) ?? sites[0]) : sites.find((entry) => entry.siteId === input.siteId);

	if (site === undefined) {
		throw new CodeIndexError(
			input.siteId === undefined ? 'symbol_not_found' : 'invalid_argument',
			input.siteId === undefined ? 'Symbol has no definition site' : `Unknown definition site: ${input.siteId}`,
		);
	}

	if (query.isPathDirty(query.symbol.path)) {
		throw new StaleFileError(query.symbol.path);
	}

	const file = query.database.getFile(query.generationId, query.symbol.path);

	if (file === null) {
		throw new CodeIndexError('file_not_indexed', `Symbol file is not in the published index: ${query.symbol.path}`);
	}

	const absolutePath = resolve(query.rootDir, query.symbol.path);

	if (!absolutePath.startsWith(`${resolve(query.rootDir)}${sep}`)) {
		throw new CodeIndexError('invalid_argument', 'Symbol path escapes the configured root');
	}

	let content: string;

	try {
		content = readFileSync(absolutePath, 'utf8');
	} catch {
		throw new StaleFileError(query.symbol.path);
	}

	if (hashContent(content) !== file.sha256) {
		throw new StaleFileError(query.symbol.path);
	}

	if (query.isPathDirty(query.symbol.path)) {
		throw new StaleFileError(query.symbol.path);
	}

	return readSymbolResult({
		content,
		symbol: query.symbol,
		site,
		generationId: query.generationId,
		freshness: query.freshness,
		contextLines: input.contextLines,
		maxReadLines: query.maxReadLines,
		maxResultBytes: query.maxResultBytes,
	});
};
