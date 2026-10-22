import {describe, expect, it} from 'vitest';
import {CodeIndexError} from '../src/core/errors/codeIndexError.ts';
import {createFixtureIndex, type FixtureProjectType} from './helpers/fixture.ts';

const PROJECTS: readonly FixtureProjectType[] = [
	{name: 'browser', project: 'tsconfig.json'},
	{name: 'contracts', project: 'contracts/tsconfig.json'},
	{name: 'server', project: 'server/tsconfig.json'},
];

describe('find_references selectors and grouping', () => {
	it('accepts exactly one selector and names both fields when neither or both are provided', () => {
		const fixture = createFixtureIndex('reference-grouping');

		try {
			for (const input of [{limit: 10}, {symbolId: 'symbol', query: 'duplicate', limit: 10}]) {
				expect(() => fixture.index.findReferences(input)).toThrow(CodeIndexError);
				expect(() => fixture.index.findReferences(input)).toThrow(/symbolId or query/u);
			}
		} finally {
			fixture.cleanup();
		}
	});

	it('keeps the flat occurrence contract for a symbolId selector', () => {
		const fixture = createFixtureIndex('simple-project');

		try {
			const symbol = fixture.index.findSymbols({query: 'formatUser', limit: 1}).items.at(0);

			if (symbol === undefined) {
				throw new Error('Expected formatUser');
			}

			const result = fixture.index.findReferences({symbolId: symbol.symbolId, limit: 100});

			expect(result).toMatchObject({
				kind: 'occurrences',
				group: 'occurrence',
				selector: 'symbolId',
				occurrencesTotal: 5,
				definitionsTotal: 1,
				truncated: false,
			});
			expect(result.items).toHaveLength(5);
			expect(result.items.some((item) => item.role === 'definition')).toBe(true);
			expect(result.items.some((item) => item.role === 'reference')).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	it('resolves a query in one call and defaults to reference-only file groups', () => {
		const fixture = createFixtureIndex('reference-grouping');

		try {
			const result = fixture.index.findReferences({query: 'duplicate', limit: 100});

			expect(result).toMatchObject({
				kind: 'files',
				group: 'file',
				selector: 'query',
				groupsTotal: 3,
				occurrencesTotal: 5,
				definitionsTotal: 1,
				unclassifiedReferences: 0,
				crossFileRefsObserved: true,
				truncated: false,
			});

			if (result.kind !== 'files') {
				throw new Error('Expected file groups');
			}

			expect(result.items).toStrictEqual([
				{path: 'src/first.ts', count: 2, usage: 3, contexts: ['root'], contextsTruncated: false},
				{path: 'src/second.ts', count: 2, usage: 3, contexts: ['root'], contextsTruncated: false},
				{path: 'src/shared.ts', count: 1, usage: 1, contexts: ['root'], contextsTruncated: false},
			]);
		} finally {
			fixture.cleanup();
		}
	});

	it('keeps definition occurrences in occurrence mode for a query selector', () => {
		const fixture = createFixtureIndex('reference-grouping');

		try {
			const result = fixture.index.findReferences({query: 'duplicate', group: 'occurrence', limit: 100});

			expect(result).toMatchObject({kind: 'occurrences', selector: 'query', occurrencesTotal: 6, definitionsTotal: 1});

			if (result.kind !== 'occurrences') {
				throw new Error('Expected occurrence items');
			}

			expect(result.items.some((item) => item.role === 'definition')).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('find_references resolution and grouping order', () => {
	it('orders owner groups by path and puts top-level code first', () => {
		const fixture = createFixtureIndex('reference-grouping');

		try {
			const result = fixture.index.findReferences({query: 'duplicate', group: 'owner', limit: 100});

			if (result.kind !== 'owners') {
				throw new Error('Expected owner groups');
			}

			expect(result.groupsTotal).toBe(5);
			expect(result.items.map((item) => [item.path, item.owner?.name ?? null])).toStrictEqual([
				['src/first.ts', null],
				['src/first.ts', 'firstUse'],
				['src/second.ts', null],
				['src/second.ts', 'secondUse'],
				['src/shared.ts', 'topLevel'],
			]);
		} finally {
			fixture.cleanup();
		}
	});

	it('prefers one exact candidate over prefix siblings and reports real ambiguity', () => {
		const exactFixture = createFixtureIndex('simple-project');
		const ambiguousFixture = createFixtureIndex('reference-grouping');

		try {
			const exact = exactFixture.index.findReferences({query: 'User', limit: 100});
			const ambiguous = ambiguousFixture.index.findReferences({query: 'repeated', limit: 100});
			const prefixAmbiguous = ambiguousFixture.index.findReferences({query: 'rep', limit: 100});

			expect(exact.kind).toBe('files');
			expect(ambiguous).toMatchObject({
				kind: 'ambiguous',
				selector: 'query',
				candidatesTotal: 2,
				candidatesTruncated: false,
			});

			if (ambiguous.kind !== 'ambiguous') {
				throw new Error('Expected ambiguous candidates');
			}

			expect(ambiguous.candidates.map((candidate) => candidate.path)).toStrictEqual(['src/duplicateA.ts', 'src/duplicateB.ts']);
			expect(ambiguous.candidates.every((candidate) => candidate.match === 'exact_name')).toBe(true);
			expect(prefixAmbiguous.kind).toBe('ambiguous');
		} finally {
			exactFixture.cleanup();
			ambiguousFixture.cleanup();
		}
	});

	it('returns an explicit text-search fallback instead of claiming source absence', () => {
		const fixture = createFixtureIndex('reference-grouping');

		try {
			const result = fixture.index.findReferences({query: 'noSuchStoredName', limit: 100});

			expect(result).toMatchObject({kind: 'none', selector: 'query', fallback: 'text_search', reason: 'no_stored_match'});

			if (result.kind !== 'none') {
				throw new Error('Expected no-match details');
			}

			expect(result.message).toContain('text search');
			expect(result.message).toContain('not evidence that no source defines it');
			expect(result.limitations.length).toBeGreaterThan(0);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('find_references filters', () => {
	it('applies role, path, usage, enclosing, and context filters before grouping', () => {
		const fixture = createFixtureIndex('simple-project');
		const multiProject = createFixtureIndex('multi-project', PROJECTS);

		try {
			const symbol = fixture.index.findSymbols({query: 'formatUser', limit: 1}).items.at(0);

			if (symbol === undefined) {
				throw new Error('Expected formatUser');
			}

			const owner = fixture.index.findSymbols({query: 'describeUser', limit: 1}).items.at(0);

			if (owner === undefined) {
				throw new Error('Expected describeUser');
			}

			const definition = fixture.index.findReferences({query: 'formatUser', group: 'file', role: 'definition', limit: 100});
			const pathFiltered = fixture.index.findReferences({symbolId: symbol.symbolId, group: 'file', path: 'src/index.ts', limit: 100});
			const usageFiltered = fixture.index.findReferences({query: 'formatUser', group: 'file', usage: 1, limit: 100});
			const enclosed = fixture.index.findReferences({symbolId: symbol.symbolId, enclosingId: owner.symbolId, limit: 100});
			const server = multiProject.index.findReferences({query: 'ServiceRequest', group: 'file', context: 'server', limit: 100});

			expect(definition.kind).toBe('files');
			expect(pathFiltered.kind === 'files' ? pathFiltered.items.map((item) => item.path) : []).toStrictEqual(['src/index.ts']);
			expect(usageFiltered.kind === 'files' ? usageFiltered.items.map((item) => item.count) : []).toStrictEqual([1, 1]);
			expect(enclosed.items).toHaveLength(1);
			expect(server.kind === 'files' ? server.items.map((item) => item.path) : []).toStrictEqual(['contracts/src/service.ts', 'server/src/routes.ts']);
			expect(server.kind === 'files' ? server.items.every((item) => item.contexts.includes('server')) : false).toBe(true);
		} finally {
			fixture.cleanup();
			multiProject.cleanup();
		}
	});
});

describe('find_references bounds and cursors', () => {
	it('rejects invalid filter combinations, unknown contexts, and cursors bound to another query', () => {
		const fixture = createFixtureIndex('reference-grouping');

		try {
			const first = fixture.index.findReferences({query: 'duplicate', limit: 1});

			if (first.kind !== 'files') {
				throw new Error('Expected file groups');
			}

			expect(first.nextCursor).not.toBeNull();
			expect(() => fixture.index.findReferences({query: 'duplicate', group: 'file', role: 'definition', usage: 1, limit: 10})).toThrow(CodeIndexError);
			expect(() => fixture.index.findReferences({query: 'duplicate', context: 'missing', limit: 10})).toThrow(CodeIndexError);
			expect(() => fixture.index.findReferences({query: 'duplicate', group: 'owner', limit: 1, cursor: first.nextCursor ?? undefined})).toThrow(CodeIndexError);
		} finally {
			fixture.cleanup();
		}
	});

	it('drops contexts first, then trailing groups, while retaining totals and cursor continuity', () => {
		const fixture = createFixtureIndex('reference-grouping');

		try {
			const contextDropped = fixture.index.findReferences({query: 'duplicate', limit: 100}, 620);

			if (contextDropped.kind !== 'files') {
				throw new Error('Expected file groups');
			}

			expect(contextDropped.groupsTotal).toBe(3);
			expect(contextDropped.occurrencesTotal).toBe(5);
			expect(contextDropped.definitionsTotal).toBe(1);
			expect(contextDropped.truncated).toBe(false);
			expect(contextDropped.nextCursor).toBeNull();
			expect(contextDropped.items).toHaveLength(3);
			expect(contextDropped.items.every((item) => item.contexts.length === 0 && item.contextsTruncated)).toBe(true);

			const shortened = fixture.index.findReferences({query: 'duplicate', limit: 100}, 600);

			if (shortened.kind !== 'files') {
				throw new Error('Expected shortened file groups');
			}

			expect(shortened.groupsTotal).toBe(3);
			expect(shortened.occurrencesTotal).toBe(5);
			expect(shortened.definitionsTotal).toBe(1);
			expect(shortened.truncated).toBe(true);
			expect(shortened.items).toHaveLength(1);
			expect(shortened.items[0]).toMatchObject({path: 'src/first.ts', contexts: [], contextsTruncated: true});
			expect(shortened.nextCursor).not.toBeNull();

			const next = fixture.index.findReferences({query: 'duplicate', limit: 100, cursor: shortened.nextCursor ?? undefined});

			if (next.kind !== 'files') {
				throw new Error('Expected continued file groups');
			}

			expect(next.items.map((item) => item.path)).toStrictEqual(['src/second.ts', 'src/shared.ts']);
			expect(next.nextCursor).toBeNull();
			expect(() => fixture.index.findReferences({query: 'duplicate', limit: 100}, 500)).toThrow(CodeIndexError);
		} finally {
			fixture.cleanup();
		}
	});
});
