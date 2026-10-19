import {describe, expect, it} from 'vitest';
import {CodeIndexError} from '../src/core/errors/errors.ts';
import {boundedPagedResult, decodeCursor} from '../src/core/query/querySupport.ts';

const cursor = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const createResult = (page: Readonly<{items: readonly number[]; nextCursor: string | null; truncated: boolean}>): unknown => page;

describe('query cursors', () => {
	it('starts at offset zero without a cursor', () => {
		expect(decodeCursor(undefined, 'generation', 'symbols')).toStrictEqual({g: 'generation', q: 'symbols', o: 0});
	});

	it('accepts a cursor for the current generation and query', () => {
		expect(decodeCursor(cursor({g: 'generation', q: 'symbols', o: 20}), 'generation', 'symbols')).toStrictEqual({
			g: 'generation',
			q: 'symbols',
			o: 20,
		});
	});

	it('rejects malformed and mismatched cursors', () => {
		expect(() => decodeCursor('not-json', 'generation', 'symbols')).toThrow(expect.objectContaining({code: 'invalid_cursor', message: 'Cursor is malformed'}));
		expect(() => decodeCursor(cursor({g: 'other', q: 'symbols', o: 0}), 'generation', 'symbols')).toThrow(
			expect.objectContaining({code: 'invalid_cursor', message: 'Cursor does not belong to the current generation or query'}),
		);
		expect(() => decodeCursor(cursor({g: 'generation', q: 'other', o: 0}), 'generation', 'symbols')).toThrow(CodeIndexError);
		expect(() => decodeCursor(cursor({g: 'generation', q: 'symbols', o: -1}), 'generation', 'symbols')).toThrow(CodeIndexError);
	});
});

describe('bounded paged results', () => {
	it('returns all items when they fit the budget', () => {
		expect(
			boundedPagedResult({
				generationId: 'generation',
				items: [1, 2, 3],
				offset: 0,
				queryKind: 'symbols',
				hasMore: false,
				maxResultBytes: 1000,
				createResult,
			}),
		).toStrictEqual({items: [1, 2, 3], nextCursor: null, truncated: false});
	});

	it('returns an empty page without a cursor', () => {
		expect(
			boundedPagedResult({
				generationId: 'generation',
				items: [],
				offset: 0,
				queryKind: 'symbols',
				hasMore: false,
				maxResultBytes: 1,
				createResult,
			}),
		).toStrictEqual({items: [], nextCursor: null, truncated: false});
	});

	it('truncates by serialized byte size and advances the cursor', () => {
		const oneItemBytes = Buffer.byteLength(JSON.stringify({items: [1], nextCursor: cursor({g: 'generation', q: 'symbols', o: 1}), truncated: true}), 'utf8');
		const result = boundedPagedResult({
			generationId: 'generation',
			items: [1, 2, 3],
			offset: 0,
			queryKind: 'symbols',
			hasMore: false,
			maxResultBytes: oneItemBytes,
			createResult,
		});

		expect(result).toMatchObject({items: [1], truncated: true});
	});

	it('rejects one item that exceeds the entire budget', () => {
		expect(() =>
			boundedPagedResult({
				generationId: 'generation',
				items: [1],
				offset: 0,
				queryKind: 'symbols',
				hasMore: false,
				maxResultBytes: 1,
				createResult,
			}),
		).toThrow(expect.objectContaining({code: 'response_too_large'}));
	});
});
