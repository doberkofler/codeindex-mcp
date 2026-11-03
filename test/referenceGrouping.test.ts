import {describe, expect, it} from 'vitest';
import {CodeIndexError} from '../src/core/errors/codeIndexError.ts';
import {type IndexDatabase} from '../src/core/storage/database.ts';
import {resolveReferencePartition} from '../src/core/query/referencePartition.ts';
import {createFixtureIndex, type FixtureProjectType} from './helpers/fixture.ts';

const PROJECTS: readonly FixtureProjectType[] = [
	{name: 'browser', project: 'tsconfig.json'},
	{name: 'contracts', project: 'contracts/tsconfig.json'},
	{name: 'server', project: 'server/tsconfig.json'},
];

describe('find_references selectors and grouping', () => {
	it('accepts exactly one selector and names both fields when neither or both are provided', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

		try {
			for (const input of [{limit: 10}, {symbolId: 'symbol', query: 'duplicate', limit: 10}]) {
				expect(() => fixture.index.findReferences(input)).toThrow(CodeIndexError);
				expect(() => fixture.index.findReferences(input)).toThrow(/symbolId or query/u);
			}
		} finally {
			fixture.cleanup();
		}
	});

	it('keeps the flat occurrence contract for a symbolId selector', async () => {
		const fixture = await createFixtureIndex('simple-project');

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

	it('resolves a query in one call and defaults to reference-only file groups', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

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
				{path: 'src/first.ts', adapter: 'typescript', count: 2, usage: 3, contexts: ['root'], contextsTruncated: false},
				{path: 'src/second.ts', adapter: 'typescript', count: 2, usage: 3, contexts: ['root'], contextsTruncated: false},
				{path: 'src/shared.ts', adapter: 'typescript', count: 1, usage: 1, contexts: ['root'], contextsTruncated: false},
			]);
		} finally {
			fixture.cleanup();
		}
	});

	it('keeps definition occurrences in occurrence mode for a query selector', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

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
	it('orders owner groups by path and puts top-level code first', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

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

	it('prefers one exact candidate over prefix siblings and reports real ambiguity', async () => {
		const exactFixture = await createFixtureIndex('simple-project');
		const ambiguousFixture = await createFixtureIndex('reference-grouping');

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

	it('returns an explicit text-search fallback instead of claiming source absence', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

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
	it('applies role, path, usage, enclosing, and context filters before grouping', async () => {
		const fixture = await createFixtureIndex('simple-project');
		const multiProject = await createFixtureIndex('multi-project', PROJECTS);

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
	it('rejects invalid filter combinations, unknown contexts, and cursors bound to another query', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

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

	it('drops contexts first, then trailing groups, while retaining totals and cursor continuity', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

		try {
			const unbounded = fixture.index.findReferences({query: 'duplicate', limit: 100}, 1_000_000);
			const fullBytes = Buffer.byteLength(JSON.stringify(unbounded), 'utf8');
			const contextDropped = fixture.index.findReferences({query: 'duplicate', limit: 100}, fullBytes - 1);

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

			const contextFreeBytes = Buffer.byteLength(JSON.stringify(contextDropped), 'utf8');
			const shortened = fixture.index.findReferences({query: 'duplicate', limit: 100}, contextFreeBytes - 1);

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
			expect(() => fixture.index.findReferences({query: 'duplicate', limit: 100}, 900)).toThrow(CodeIndexError);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('find_references partition scope', () => {
	it('keeps the default scope to exactly one symbol', async () => {
		const fixture = await createFixtureIndex('external-reexport');

		try {
			const seed = fixture.index.findSymbols({query: 'debounce', path: 'src/facade.ts', limit: 10}).items.at(0);

			if (seed === undefined) {
				throw new Error('Expected the facade alias');
			}

			const result = fixture.index.findReferences({symbolId: seed.symbolId, limit: 100});

			expect(result.partition).toMatchObject({
				scope: 'partition',
				externalTarget: 'external-package',
				externalName: 'externalDebounce',
				completeness: 'complete',
			});
			expect(result.partition?.memberSymbols).toHaveLength(1);
			expect(result.partition?.siblingSymbols).toStrictEqual([]);
			expect(result.partition?.memberSymbols[0]?.symbolId).toBe(seed.symbolId);
			expect(result.items.every((item) => item.symbolId === seed.symbolId)).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	it('expands an external alias group without fanning one occurrence out to several symbols', async () => {
		const fixture = await createFixtureIndex('external-reexport');

		try {
			const seed = fixture.index.findSymbols({query: 'debounce', path: 'src/facade.ts', limit: 10}).items.at(0);

			if (seed === undefined) {
				throw new Error('Expected the facade alias');
			}

			const partition = fixture.index.findReferences({symbolId: seed.symbolId, limit: 100});
			const group = fixture.index.findReferences({symbolId: seed.symbolId, scope: 'external_alias_group', limit: 100});

			expect(partition.kind).toBe('occurrences');
			expect(group.kind).toBe('occurrences');
			expect(group.partition).toMatchObject({
				scope: 'external_alias_group',
				externalTarget: 'external-package',
				externalName: 'externalDebounce',
				completeness: 'complete',
			});
			expect(group.partition?.memberSymbols).toHaveLength(2);
			expect(group.partition?.siblingSymbols).toHaveLength(1);
			expect(group.definitionsTotal).toBe(2);
			expect(group.occurrencesTotal).toBeGreaterThan(partition.occurrencesTotal);

			const members = new Set((group.partition?.memberSymbols ?? []).map((member) => member.symbolId));

			expect(group.items.every((item) => members.has(item.symbolId))).toBe(true);
			expect(new Set(group.items.map((item) => `${item.symbolId}:${item.path}:${String(item.startOffset)}:${item.role}`)).size).toBe(group.items.length);
			expect(group.items.some((item) => item.path === 'src/direct.ts')).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	it('paginates an alias group across member boundaries without duplicating an occurrence', async () => {
		const fixture = await createFixtureIndex('external-reexport');

		try {
			const seed = fixture.index.findSymbols({query: 'debounce', path: 'src/facade.ts', limit: 10}).items.at(0);

			if (seed === undefined) {
				throw new Error('Expected the facade alias');
			}

			const group = fixture.index.findReferences({symbolId: seed.symbolId, scope: 'external_alias_group', limit: 100});
			const paged: (typeof group.items)[number][] = [];
			let cursor: string | undefined;

			do {
				const page = fixture.index.findReferences({
					symbolId: seed.symbolId,
					scope: 'external_alias_group',
					limit: 1,
					...(cursor === undefined ? {} : {cursor}),
				});
				paged.push(...page.items);
				cursor = page.nextCursor ?? undefined;
			} while (cursor !== undefined);

			expect(paged).toHaveLength(group.occurrencesTotal);
			expect(new Set(paged.map((item) => `${item.symbolId}:${item.path}:${String(item.startOffset)}:${item.role}`)).size).toBe(paged.length);
		} finally {
			fixture.cleanup();
		}
	});

	it('rejects an alias group for a symbol without an external target', async () => {
		const fixture = await createFixtureIndex('simple-project');

		try {
			const symbol = fixture.index.findSymbols({query: 'formatUser', limit: 1}).items.at(0);

			if (symbol === undefined) {
				throw new Error('Expected formatUser');
			}

			expect(() => fixture.index.findReferences({symbolId: symbol.symbolId, scope: 'external_alias_group', limit: 10})).toThrow(CodeIndexError);
			expect(() => fixture.index.findReferences({symbolId: symbol.symbolId, scope: 'external_alias_group', limit: 10})).toThrow(
				/external_alias_group requires an indexed external alias/u,
			);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('find_references partition completeness', () => {
	it('reports bounded completeness when a member has no stored definition', () => {
		const summary = {
			id: 'seed',
			name: 'debounce',
			qualifiedName: 'debounce',
			kind: 'alias',
			path: 'src/facade.ts',
			startLine: 1,
			startColumn: 1,
			endLine: 1,
			endColumn: 10,
			enclosingId: null,
			startOffset: 0,
			endOffset: 10,
			contexts: ['root'],
			externalTarget: 'external-package',
			externalName: 'debounce',
		};
		const database = {
			getSymbol: () => summary,
			externalAliasGroup: () => ({externalTarget: 'external-package', externalName: 'debounce', members: [summary, {...summary, id: 'sibling'}]}),
			definitionCountsBySymbol: () =>
				new Map([
					['seed', 1],
					['sibling', 0],
				]),
		} as unknown as IndexDatabase;

		const resolved = resolveReferencePartition(database, 'generation', 'seed', {scope: 'external_alias_group'});

		expect(resolved.symbolIds).toStrictEqual(['seed', 'sibling']);
		expect(resolved.partition.completeness).toBe('bounded');
		expect(resolved.partition.siblingSymbols.map((member) => member.symbolId)).toStrictEqual(['sibling']);
	});

	it('bounds member lists while keeping the whole-partition totals', () => {
		const summary = {
			id: 'seed',
			name: 'debounce',
			qualifiedName: 'debounce',
			kind: 'alias',
			path: 'src/facade.ts',
			startLine: 1,
			startColumn: 1,
			endLine: 1,
			endColumn: 10,
			enclosingId: null,
			startOffset: 0,
			endOffset: 10,
			contexts: ['root'],
			externalTarget: 'external-package',
			externalName: 'debounce',
		};
		const members = [summary, ...Array.from({length: 24}, (_, index) => ({...summary, id: `member-${String(index)}`}))];
		const database = {
			getSymbol: () => summary,
			externalAliasGroup: () => ({externalTarget: 'external-package', externalName: 'debounce', members}),
			definitionCountsBySymbol: () => new Map(members.map((member) => [member.id, 1])),
		} as unknown as IndexDatabase;

		const resolved = resolveReferencePartition(database, 'generation', 'seed', {scope: 'external_alias_group'});

		expect(resolved.partition.memberSymbols).toHaveLength(20);
		expect(resolved.partition.memberSymbolsTotal).toBe(25);
		expect(resolved.partition.siblingSymbolsTotal).toBe(24);
		expect(resolved.partition.membersTruncated).toBe(true);
		expect(resolved.partition.completeness).toBe('complete');
	});
});
