import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {CodeIndexError} from '../errors/errors.ts';
import {type CodeIndex} from '../generation/codeIndex.ts';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const IdentifierSchema = z.string().min(1).max(128).regex(ID_PATTERN);
const AdapterSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_-]*$/u)
	.optional();
const ContextSchema = z.string().min(1).max(256).optional();
const LimitSchema = z.number().int().min(1).max(100);
const MatchSchema = z.enum(['name', 'qualified']).optional();
const ExposureSchema = z.enum(['published', 'reachable', 'visible', 'internal', 'any']).optional();

export const RELEASE_QUERY_OPERATIONS = ['find_symbol', 'symbol_at', 'find_references', 'find_dependencies', 'read_symbol'] as const;

export const ReleaseEditCaseSchema = z
	.object({
		id: IdentifierSchema,
		adapterId: IdentifierSchema,
		path: z
			.string()
			.min(1)
			.max(4096)
			.refine(
				(value) =>
					!path.isAbsolute(value) && !value.includes('\\') && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
				'edit path must be a workspace-relative POSIX path',
			),
		append: z.string().min(1).max(16_384),
		symbolQuery: z.string().min(1).max(1024),
	})
	.strict();

export type ReleaseEditCaseType = z.infer<typeof ReleaseEditCaseSchema>;

const FindSymbolInputSchema = z
	.object({
		query: z.string(),
		match: MatchSchema,
		kind: z.string().min(1).max(64).optional(),
		container: z.string().optional(),
		path: z.string().min(1).optional(),
		context: ContextSchema,
		adapter: AdapterSchema,
		exposure: ExposureSchema,
		limit: LimitSchema,
	})
	.strict();

const SymbolAtInputSchema = z
	.object({
		path: z.string().min(1),
		line: z.number().int().positive(),
		column: z.number().int().positive().optional(),
		adapter: AdapterSchema,
	})
	.strict();

const FindReferencesInputSchema = z
	.object({
		query: z.string().min(1),
		match: MatchSchema,
		kind: z.string().min(1).max(64).optional(),
		container: z.string().optional(),
		exposure: ExposureSchema,
		group: z.enum(['file', 'owner']).optional(),
		role: z.enum(['definition', 'reference']).optional(),
		path: z.string().min(1).optional(),
		usage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).optional(),
		context: ContextSchema,
		adapter: AdapterSchema,
		scope: z.enum(['partition', 'external_alias_group']).optional(),
		limit: LimitSchema,
	})
	.strict();

const FindDependenciesInputSchema = z
	.object({
		target: z.string().min(1),
		context: ContextSchema,
		adapter: AdapterSchema,
		direction: z.literal('consumers').optional(),
		transitive: z.boolean().optional(),
		root: z.string().min(1).optional(),
		detail: z.enum(['compact', 'evidence']).optional(),
		limit: LimitSchema,
	})
	.strict();

const ReadSymbolInputSchema = z
	.object({
		query: z.string().min(1),
		match: MatchSchema,
		kind: z.string().min(1).max(64).optional(),
		container: z.string().optional(),
		path: z.string().min(1).optional(),
		exposure: ExposureSchema,
		mode: z.enum(['text', 'sites', 'names']).optional(),
		context: ContextSchema,
		adapter: AdapterSchema,
		contextLines: z.number().int().min(0).max(20),
		limit: LimitSchema.optional(),
	})
	.strict();

const queryCaseFields = {
	id: IdentifierSchema,
	expectedSha256: z.string().regex(HASH_PATTERN),
	expectedAdapters: z.array(IdentifierSchema).min(1),
	minimumPages: z.number().int().positive().max(10_000),
	duplicateName: z.boolean(),
} as const;

/**
 * One typed query case. The closed operation union is deliberately not an
 * executable command surface.
 */
export const ReleaseQueryCaseSchema = z
	.discriminatedUnion('operation', [
		z.object({...queryCaseFields, operation: z.literal('find_symbol'), input: FindSymbolInputSchema}).strict(),
		z.object({...queryCaseFields, operation: z.literal('symbol_at'), input: SymbolAtInputSchema}).strict(),
		z.object({...queryCaseFields, operation: z.literal('find_references'), input: FindReferencesInputSchema}).strict(),
		z.object({...queryCaseFields, operation: z.literal('find_dependencies'), input: FindDependenciesInputSchema}).strict(),
		z.object({...queryCaseFields, operation: z.literal('read_symbol'), input: ReadSymbolInputSchema}).strict(),
	])
	.superRefine((queryCase, context) => {
		const sorted = [...queryCase.expectedAdapters].sort();

		if (new Set(queryCase.expectedAdapters).size !== queryCase.expectedAdapters.length) {
			context.addIssue({code: 'custom', path: ['expectedAdapters'], message: 'expected adapters must be unique'});
		}

		if (queryCase.expectedAdapters.some((adapter, index) => adapter !== sorted[index])) {
			context.addIssue({code: 'custom', path: ['expectedAdapters'], message: 'expected adapters must use canonical sorted order'});
		}

		if (queryCase.duplicateName && (queryCase.operation !== 'find_symbol' || queryCase.expectedAdapters.length < 2)) {
			context.addIssue({
				code: 'custom',
				path: ['duplicateName'],
				message: 'a duplicate-name case must be a find_symbol query spanning at least two adapters',
			});
		}
	});

export type ReleaseQueryCaseType = z.infer<typeof ReleaseQueryCaseSchema>;

export type ReleaseQueryCaseResultType = Readonly<{
	readonly id: string;
	readonly operation: ReleaseQueryCaseType['operation'];
	readonly inputSha256: string;
	readonly sha256: string;
	readonly adapters: readonly string[];
	readonly pages: number;
	readonly generationIdSha256: string;
}>;

const canonicalValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalValue(entry));
	}

	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !['freshness', 'generationId', 'nextCursor'].includes(key))
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}

	return value;
};

const digest = (value: unknown): string =>
	createHash('sha256')
		.update(JSON.stringify(canonicalValue(value)))
		.digest('hex');

/**
 * Returns the canonical identity of a typed query input.
 *
 * @param queryCase - Validated query case.
 * @returns SHA-256 of the canonical query input.
 */
export const releaseQueryInputDigest = (queryCase: ReleaseQueryCaseType): string => digest(queryCase.input);

/**
 * Returns the closed identity of an edit target without exposing its path.
 *
 * @param editCase - Validated deterministic edit.
 * @returns Canonical path SHA-256.
 */
export const releaseEditPathDigest = (editCase: ReleaseEditCaseType): string => digest(editCase.path);

/**
 * Returns the closed identity of an edit mutation without exposing source text.
 *
 * @param editCase - Validated deterministic edit.
 * @returns Canonical mutation SHA-256.
 */
export const releaseEditMutationDigest = (editCase: ReleaseEditCaseType): string => digest(editCase.append);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const generationIdOf = (value: unknown): string => {
	if (!isRecord(value) || typeof value['generationId'] !== 'string') {
		throw new Error('Release qualification query returned no generation identity');
	}

	return value['generationId'];
};

const nextCursorOf = (value: unknown): string | null => {
	if (!isRecord(value)) {
		return null;
	}

	const cursor = value['nextCursor'];
	if (cursor === undefined || cursor === null) {
		return null;
	}

	if (typeof cursor !== 'string') {
		throw new TypeError('Release qualification query returned an invalid cursor');
	}

	return cursor;
};

const collectAdapters = (value: unknown, adapters: Set<string>): void => {
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectAdapters(entry, adapters);
		}

		return;
	}

	if (!isRecord(value)) {
		return;
	}

	for (const [key, entry] of Object.entries(value)) {
		if (key === 'adapter' && typeof entry === 'string') {
			adapters.add(entry);
		} else {
			collectAdapters(entry, adapters);
		}
	}
};

const executeQuery = (index: CodeIndex, queryCase: ReleaseQueryCaseType, cursor?: string): unknown => {
	switch (queryCase.operation) {
		case 'find_symbol': {
			return index.findSymbols({...queryCase.input, ...(cursor === undefined ? {} : {cursor})});
		}
		case 'symbol_at': {
			return index.symbolAt(queryCase.input);
		}
		case 'find_references': {
			return index.findReferences({...queryCase.input, ...(cursor === undefined ? {} : {cursor})});
		}
		case 'find_dependencies': {
			return index.findDependencies({...queryCase.input, ...(cursor === undefined ? {} : {cursor})});
		}
		case 'read_symbol': {
			return index.readSymbol({...queryCase.input, ...(cursor === undefined ? {} : {cursor})});
		}
		default: {
			throw new Error('Unsupported release qualification query operation');
		}
	}
};

const queryCaseResult = (index: CodeIndex, queryCase: ReleaseQueryCaseType): ReleaseQueryCaseResultType => {
	const pages: unknown[] = [];
	const generationIds = new Set<string>();
	const adapters = new Set<string>();
	let cursor: string | undefined;

	do {
		const result = executeQuery(index, queryCase, cursor);
		pages.push(result);
		generationIds.add(generationIdOf(result));
		collectAdapters(result, adapters);
		cursor = nextCursorOf(result) ?? undefined;

		if (pages.length > 10_000) {
			throw new Error(`Release qualification query exceeded the page bound: ${queryCase.id}`);
		}
	} while (cursor !== undefined);

	if (generationIds.size !== 1) {
		throw new Error(`Release qualification query crossed published generations: ${queryCase.id}`);
	}

	const [generationId] = generationIds;
	if (generationId === undefined) {
		throw new Error(`Release qualification query returned no generation: ${queryCase.id}`);
	}

	return {
		id: queryCase.id,
		operation: queryCase.operation,
		inputSha256: releaseQueryInputDigest(queryCase),
		sha256: digest(pages),
		adapters: [...adapters].sort(),
		pages: pages.length,
		generationIdSha256: digest(generationId),
	};
};

/**
 * Executes every typed manifest query through the production query interface.
 *
 * Pagination is exhausted, every page must read one generation, and the
 * returned evidence contains only hashes, counts, case IDs, and adapter IDs.
 *
 * @param index - Ready multi-adapter index.
 * @param queryCases - Validated deterministic query cases.
 * @returns Privacy-safe query evidence in manifest order.
 */
export const runReleaseQueryCases = (index: CodeIndex, queryCases: readonly ReleaseQueryCaseType[]): readonly ReleaseQueryCaseResultType[] =>
	queryCases.map((queryCase) => queryCaseResult(index, queryCase));

/**
 * Proves `read_symbol` rejects source changed after publication.
 *
 * The caller must supply a disposable workspace. Original bytes are restored
 * before this function returns or propagates an error.
 *
 * @param input - Ready index, disposable workspace root, and deterministic edit.
 * @returns True only when the read failed with `stale_file`.
 */
export const runReleaseStaleFileCase = (
	input: Readonly<{
		readonly index: CodeIndex;
		readonly rootDir: string;
		readonly workspace: 'disposable_copy';
		readonly editCase: ReleaseEditCaseType;
	}>,
): boolean => {
	const {editCase} = input;
	const absolutePath = path.resolve(input.rootDir, editCase.path);
	const relativePath = path.relative(input.rootDir, absolutePath);

	if (relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		throw new Error('Release qualification edit escaped the disposable workspace');
	}

	const [symbol] = input.index.findSymbols({
		query: editCase.symbolQuery,
		path: editCase.path,
		adapter: editCase.adapterId,
		limit: 1,
	}).items;

	if (symbol === undefined) {
		throw new Error(`Release qualification stale-file case resolved no symbol: ${editCase.id}`);
	}

	const original = readFileSync(absolutePath);

	try {
		writeFileSync(absolutePath, Buffer.concat([original, Buffer.from(editCase.append, 'utf8')]));

		try {
			input.index.readSymbol({symbolId: symbol.symbolId, adapter: editCase.adapterId, contextLines: 0});
			return false;
		} catch (error) {
			return error instanceof CodeIndexError && error.code === 'stale_file';
		}
	} finally {
		writeFileSync(absolutePath, original);
	}
};
