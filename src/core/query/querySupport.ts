import {z} from 'zod';
import {CodeIndexError} from '../errors/errors.ts';

const CursorSchema = z.object({
	g: z.string().min(1),
	q: z.string().min(1),
	o: z.number().int().nonnegative(),
});

export type CursorType = z.infer<typeof CursorSchema>;

const encodeCursor = (cursor: CursorType): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

type PageType<ItemType> = Readonly<{
	items: readonly ItemType[];
	nextCursor: string | null;
	truncated: boolean;
}>;

const pageOf = <ItemType>(
	input: Readonly<{
		generationId: string;
		items: readonly ItemType[];
		count: number;
		offset: number;
		queryKind: string;
		hasMore: boolean;
	}>,
): PageType<ItemType> => {
	const truncated = input.hasMore || input.count < input.items.length;

	return {
		items: input.items.slice(0, input.count),
		nextCursor: truncated ? encodeCursor({g: input.generationId, q: input.queryKind, o: input.offset + input.count}) : null,
		truncated,
	};
};

export const decodeCursor = (value: string | undefined, generationId: string, queryKind: string): CursorType => {
	if (value === undefined) {
		return {g: generationId, q: queryKind, o: 0};
	}

	try {
		const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));

		if (!parsed.success || parsed.data.g !== generationId || parsed.data.q !== queryKind) {
			throw new CodeIndexError('invalid_cursor', 'Cursor does not belong to the current generation or query');
		}

		return parsed.data;
	} catch (error) {
		if (error instanceof CodeIndexError) {
			throw error;
		}

		throw new CodeIndexError('invalid_cursor', 'Cursor is malformed');
	}
};

/**
 * Builds the largest leading page whose serialized result fits a byte budget.
 *
 * Cursor advancement uses the emitted item count, preventing skipped items when
 * the byte bound shortens a caller-requested page.
 *
 * @param input - Candidate items, cursor identity, byte budget, and result builder.
 * @returns A byte-bounded result with a cursor for the first omitted item.
 * @throws {@link CodeIndexError} When one result item cannot fit the budget.
 */
export const boundedPagedResult = <ItemType, ResultType>(
	input: Readonly<{
		generationId: string;
		items: readonly ItemType[];
		offset: number;
		queryKind: string;
		hasMore: boolean;
		maxResultBytes: number;
		createResult: (page: PageType<ItemType>) => ResultType;
	}>,
): ResultType => {
	const resultFor = (count: number): ResultType =>
		input.createResult(
			pageOf({
				generationId: input.generationId,
				items: input.items,
				count,
				offset: input.offset,
				queryKind: input.queryKind,
				hasMore: input.hasMore,
			}),
		);

	if (input.items.length === 0) {
		return resultFor(0);
	}

	let lower = 1;
	let upper = input.items.length;
	let selected: ResultType | null = null;

	while (lower <= upper) {
		const count = Math.floor((lower + upper) / 2);
		const candidate = resultFor(count);
		const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');

		if (bytes <= input.maxResultBytes) {
			selected = candidate;
			lower = count + 1;
		} else {
			upper = count - 1;
		}
	}

	if (selected === null) {
		throw new CodeIndexError('response_too_large', `One result item exceeds ${input.maxResultBytes} bytes`);
	}

	return selected;
};

/** Adapter-owned folding of one authored query name to its published spelling. */
export type QueryNameNormalizerType = (text: string) => string;

/**
 * Applies the selected adapter's query-name normalization to one name.
 *
 * Storage compares binding names verbatim, so an adapter whose canonical names
 * differ from authored text owns the folding rule. Without a rule the text stays
 * byte-identical.
 *
 * @param normalize - Optional adapter rule.
 * @param text - Authored name.
 * @returns The canonical published spelling.
 */
export const normalizeQueryText = (normalize: QueryNameNormalizerType | undefined, text: string): string => (normalize === undefined ? text : normalize(text));

/**
 * Applies the adapter's query-name normalization to one query-bearing request.
 *
 * @param normalize - Optional adapter rule.
 * @param input - Query-bearing request.
 * @returns The same request with a normalized query, or the original request.
 */
export const withNormalizedQuery = <Request extends {query?: string | undefined}>(normalize: QueryNameNormalizerType | undefined, input: Request): Request =>
	normalize === undefined || input.query === undefined ? input : {...input, query: normalizeQueryText(normalize, input.query)};

export const normalizeRelativePath = (path: string): string => {
	if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
		throw new CodeIndexError('invalid_argument', 'Path must be a repository-relative POSIX path without parent segments');
	}

	return path;
};
