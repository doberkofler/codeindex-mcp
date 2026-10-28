import {appendFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeIndexError, StaleFileError} from '../src/core/errors/errors.ts';
import {type DependencyConsumerItemType, type DependencyEvidenceConsumerType} from '../src/core/model.ts';
import {createFixtureIndex, type FixtureContextType} from './helpers/fixture.ts';

const evidenceOf = (item: DependencyConsumerItemType | undefined): DependencyEvidenceConsumerType | undefined =>
	item !== undefined && 'evidence' in item ? item : undefined;

describe('CodeIndex queries', () => {
	let fixture: FixtureContextType | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('finds declarations by exact name and reports qualified names', () => {
		fixture = createFixtureIndex('simple-project');

		const result = fixture.index.findSymbols({query: 'formatUser', limit: 10});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			name: 'formatUser',
			kind: 'variable',
			path: 'src/models.ts',
			match: 'exact_name',
		});
	});

	it('finds class members with qualified names', () => {
		fixture = createFixtureIndex('simple-project');

		const result = fixture.index.findSymbols({query: 'module["src/models.ts"]::UserService.find', match: 'qualified', limit: 10});

		expect(result.items[0]).toMatchObject({
			name: 'find',
			kind: 'method',
			qualifiedName: 'module["src/models.ts"]::UserService.find',
			path: 'src/models.ts',
		});
	});

	it('lists an outline in source order with kind filtering', () => {
		fixture = createFixtureIndex('simple-project');

		const all = fixture.index.getOutline({path: 'src/models.ts', limit: 100});
		const classes = fixture.index.getOutline({path: 'src/models.ts', kinds: ['class'], limit: 100});

		expect(all.items.map((item) => item.name)).toContain('formatUser');
		expect(all.items.map((item) => item.name)).toContain('describe');
		expect(classes.items.map((item) => item.name)).toStrictEqual(['UserService']);
	});

	it('paginates deterministically and rejects malformed cursors', () => {
		fixture = createFixtureIndex('simple-project');
		const {index} = fixture;

		const first = index.getOutline({path: 'src/models.ts', limit: 2});
		const second = index.getOutline({path: 'src/models.ts', limit: 2, cursor: first.nextCursor ?? undefined});

		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		expect(second.items.map((item) => item.id)).not.toStrictEqual(first.items.map((item) => item.id));
		expect(() => index.getOutline({path: 'src/models.ts', limit: 2, cursor: 'not-a-cursor'})).toThrow(CodeIndexError);
	});

	it('finds definitions and references for a symbol', () => {
		fixture = createFixtureIndex('simple-project');
		const symbol = fixture.index.findSymbols({query: 'formatUser', limit: 1}).items.at(0);

		if (symbol === undefined) {
			throw new Error('Expected formatUser symbol');
		}
		const result = fixture.index.findReferences({symbolId: symbol.id, limit: 100});

		expect(result.items.some((item) => item.role === 'definition' && item.path === 'src/models.ts')).toBe(true);
		expect(result.items.some((item) => item.role === 'reference' && item.path === 'src/index.ts')).toBe(true);
		expect(result.items.some((item) => item.role === 'reference' && item.path === 'src/models.ts')).toBe(true);
	});

	it('preserves authored re-exports whose canonical declaration is external', () => {
		fixture = createFixtureIndex('external-reexport');
		const symbol = fixture.index.findSymbols({query: 'debounce', limit: 10}).items.at(0);

		expect(symbol).toMatchObject({name: 'debounce', path: 'src/facade.ts', kind: 'alias'});

		if (symbol === undefined) {
			throw new Error('Expected debounce façade symbol');
		}

		const references = fixture.index.findReferences({symbolId: symbol.id, limit: 100});

		expect(references.items.some((item) => item.role === 'definition' && item.path === 'src/facade.ts')).toBe(true);
		expect(references.items.some((item) => item.role === 'reference' && item.path === 'src/consumer.ts')).toBe(true);
		expect(references.items.filter((item) => item.role === 'definition').every((item) => item.path === 'src/facade.ts')).toBe(true);
	});

	it('reads bounded symbol source with context', () => {
		fixture = createFixtureIndex('simple-project');
		const symbol = fixture.index.findSymbols({query: 'formatUser', limit: 1}).items.at(0);

		if (symbol === undefined) {
			throw new Error('Expected formatUser symbol');
		}

		const result = fixture.index.readSymbol({symbolId: symbol.id, contextLines: 1});

		if (result.kind !== 'text') {
			throw new Error('Expected text read result');
		}

		expect(result.source).toContain('export const formatUser');
		expect(result.startLine).toBeLessThanOrEqual(symbol.startLine);
		expect(result.truncated).toBe(false);
	});
});

describe('CodeIndex query-based symbol reads', () => {
	let fixture: FixtureContextType | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('resolves one match and reports ambiguity or explicit fallback', () => {
		fixture = createFixtureIndex('simple-project');

		const resolved = fixture.index.readSymbol({query: 'formatUser', contextLines: 0});
		const ambiguous = fixture.index.readSymbol({query: 'd', contextLines: 0});
		const missing = fixture.index.readSymbol({query: 'notStoredAnywhere', contextLines: 0});

		expect(resolved).toMatchObject({kind: 'text', source: expect.stringContaining('export const formatUser')});
		expect(ambiguous).toMatchObject({kind: 'ambiguous', selector: 'query', candidatesTruncated: false});
		if (ambiguous.kind !== 'ambiguous') {
			throw new Error('Expected ambiguous read result');
		}
		expect(ambiguous.candidates.length).toBeGreaterThan(1);
		expect(missing).toMatchObject({kind: 'none', selector: 'query', reason: 'no_stored_match', fallback: 'text_search'});
	});

	it('requires exactly one selector', () => {
		fixture = createFixtureIndex('simple-project');

		expect(() => fixture?.index.readSymbol({contextLines: 0})).toThrow('Provide exactly one selector');
		expect(() => fixture?.index.readSymbol({symbolId: 'symbol', query: 'formatUser', contextLines: 0})).toThrow('Provide exactly one selector');
	});
});

describe('CodeIndex direct dependency usage', () => {
	let fixture: FixtureContextType | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('returns compact direct package usage by default', () => {
		fixture = createFixtureIndex('dependency-graph');
		const result = fixture.index.findDependencies({target: 'lodash', limit: 50});

		expect(result.queryMeaning).toBe('direct_usage');
		expect(result.items).toStrictEqual([
			{path: 'src/adapters/escape.ts', depth: 1, directRoot: 'src/adapters/escape.ts'},
			{path: 'src/adapters/lodash_api.ts', depth: 1, directRoot: 'src/adapters/lodash_api.ts'},
			{path: 'src/cycle/a.ts', depth: 1, directRoot: 'src/cycle/a.ts'},
		]);
		expect(result.items[0]).not.toHaveProperty('evidence');
		expect(result.summary).toStrictEqual({
			totalConsumers: 3,
			directConsumers: 3,
			transitiveConsumers: 0,
			roots: [],
		});
	});

	it('adds edge evidence, locations, and bindings only when requested', () => {
		fixture = createFixtureIndex('dependency-graph');
		const result = fixture.index.findDependencies({target: 'lodash', detail: 'evidence', limit: 50});
		const adapter = evidenceOf(result.items.find((item) => item.path === 'src/adapters/lodash_api.ts'));

		expect(adapter).toMatchObject({
			directRoot: 'src/adapters/lodash_api.ts',
			relationship: 'direct',
			evidenceCount: 1,
			evidence: {rawTarget: 'lodash', targetIdentifier: 'lodash', kind: 'import', targetPath: null},
		});
		expect(adapter?.evidence.bindings).toContainEqual({
			kind: 'named',
			importedName: 'debounce',
			exportedName: null,
			localName: 'externalDebounce',
			compileTimeOnly: false,
		});

		expect(evidenceOf(result.items.find((item) => item.path === 'src/adapters/escape.ts'))?.evidence).toMatchObject({
			rawTarget: 'lodash/escape.js',
			targetIdentifier: 'lodash',
		});
	});

	it('normalizes scoped packages and preserves type-only bindings', () => {
		fixture = createFixtureIndex('dependency-graph');
		const result = fixture.index.findDependencies({target: '@scope/pkg', detail: 'evidence', limit: 50});
		const scoped = evidenceOf(result.items[0]);

		expect(result.items.map((item) => item.path)).toStrictEqual(['src/adapters/scoped.ts']);
		expect(scoped?.evidence.bindings).toContainEqual({
			kind: 'default',
			importedName: 'default',
			exportedName: null,
			localName: 'measure',
			compileTimeOnly: false,
		});
		expect(scoped?.evidence.bindings).toContainEqual({
			kind: 'named',
			importedName: 'Shape',
			exportedName: null,
			localName: 'Shape',
			compileTimeOnly: true,
		});
	});
});

describe('CodeIndex module impact', () => {
	let fixture: FixtureContextType | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('groups module impact by direct root with shortest depth and no cycles', () => {
		fixture = createFixtureIndex('dependency-graph');
		const result = fixture.index.findDependencies({target: 'lodash', transitive: true, detail: 'evidence', limit: 100});

		expect(result.queryMeaning).toBe('dependency_impact');
		expect(result.items.map((item) => ({directRoot: item.directRoot, path: item.path, depth: item.depth}))).toStrictEqual([
			{directRoot: 'src/adapters/escape.ts', path: 'src/adapters/escape.ts', depth: 1},
			{directRoot: 'src/adapters/escape.ts', path: 'src/consumers/two.ts', depth: 2},
			{directRoot: 'src/adapters/lodash_api.ts', path: 'src/adapters/lodash_api.ts', depth: 1},
			{directRoot: 'src/adapters/lodash_api.ts', path: 'src/consumers/dynamic.ts', depth: 2},
			{directRoot: 'src/adapters/lodash_api.ts', path: 'src/consumers/one.ts', depth: 2},
			{directRoot: 'src/adapters/lodash_api.ts', path: 'src/consumers/four.ts', depth: 3},
			{directRoot: 'src/cycle/a.ts', path: 'src/cycle/a.ts', depth: 1},
			{directRoot: 'src/cycle/a.ts', path: 'src/cycle/b.ts', depth: 2},
		]);
		expect(evidenceOf(result.items.find((item) => item.path === 'src/consumers/dynamic.ts'))?.evidence.kind).toBe('dynamic-import');
		expect(result.items.filter((item) => item.path === 'src/cycle/a.ts')).toHaveLength(1);
		expect(result.summary).toStrictEqual({
			totalConsumers: 8,
			directConsumers: 3,
			transitiveConsumers: 5,
			roots: [
				{path: 'src/adapters/escape.ts', consumerCount: 2},
				{path: 'src/adapters/lodash_api.ts', consumerCount: 4},
				{path: 'src/cycle/a.ts', consumerCount: 2},
			],
		});
	});

	it('reports non-additive root counts when impact paths overlap', () => {
		fixture = createFixtureIndex('dependency-impact');
		const result = fixture.index.findDependencies({target: 'lodash', transitive: true, limit: 100});

		expect(result.summary).toStrictEqual({
			totalConsumers: 53,
			directConsumers: 2,
			transitiveConsumers: 51,
			roots: [
				{path: 'src/boundary/barrel.ts', consumerCount: 42},
				{path: 'src/boundary/narrow.ts', consumerCount: 42},
			],
		});
		expect(result.items).toHaveLength(84);
		expect(
			result.items
				.filter((item) => item.path === 'src/shared/shared.ts')
				.map((item) => item.directRoot)
				.sort(),
		).toStrictEqual(['src/boundary/barrel.ts', 'src/boundary/narrow.ts']);
	});

	it('filters impact to one direct root', () => {
		fixture = createFixtureIndex('dependency-impact');
		const result = fixture.index.findDependencies({target: 'lodash', transitive: true, root: 'src/boundary/narrow.ts', limit: 100});

		expect(result.items.every((item) => item.directRoot === 'src/boundary/narrow.ts')).toBe(true);
		expect(result.items).toHaveLength(42);
		expect(result.summary).toStrictEqual({
			totalConsumers: 42,
			directConsumers: 1,
			transitiveConsumers: 41,
			roots: [{path: 'src/boundary/narrow.ts', consumerCount: 42}],
		});
	});

	it('rejects root filters that are not direct consumers or not in impact mode', () => {
		fixture = createFixtureIndex('dependency-impact');

		expect(() => fixture?.index.findDependencies({target: 'lodash', transitive: true, root: 'src/shared/shared.ts', limit: 10})).toThrow(CodeIndexError);
		expect(() => fixture?.index.findDependencies({target: 'lodash', transitive: false, root: 'src/boundary/narrow.ts', limit: 10})).toThrow(CodeIndexError);
	});

	it('does not treat TypeScript path aliases as packages', () => {
		fixture = createFixtureIndex('dependency-graph');

		expect(fixture.index.findDependencies({target: '@app/adapters', transitive: true, limit: 10}).items).toHaveLength(0);
	});
});

describe('CodeIndex dependency pagination', () => {
	let fixture: FixtureContextType | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('paginates grouped impact and rejects cursors reused with different semantics', () => {
		fixture = createFixtureIndex('dependency-impact');
		const {index} = fixture;
		const first = index.findDependencies({target: 'lodash', transitive: true, limit: 7});
		const second = index.findDependencies({target: 'lodash', transitive: true, limit: 7, cursor: first.nextCursor ?? undefined});

		expect(first.items).toHaveLength(7);
		expect(first.summary.totalConsumers).toBe(53);
		expect(first.nextCursor).not.toBeNull();
		expect(second.items.map((item) => `${item.directRoot}:${item.path}`)).not.toStrictEqual(first.items.map((item) => `${item.directRoot}:${item.path}`));
		expect(() =>
			index.findDependencies({
				target: 'lodash',
				transitive: true,
				detail: 'evidence',
				limit: 7,
				cursor: first.nextCursor ?? undefined,
			}),
		).toThrow(CodeIndexError);
		expect(() =>
			index.findDependencies({
				target: 'lodash',
				transitive: true,
				root: 'src/boundary/narrow.ts',
				limit: 7,
				cursor: first.nextCursor ?? undefined,
			}),
		).toThrow(CodeIndexError);
		expect(() => index.findDependencies({target: 'lodash', transitive: false, limit: 7, cursor: first.nextCursor ?? undefined})).toThrow(CodeIndexError);
	});
});

describe('CodeIndex freshness', () => {
	let fixture: FixtureContextType | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('refuses stale source and recovers after a rebuild', async () => {
		fixture = createFixtureIndex('simple-project');
		const symbol = fixture.index.findSymbols({query: 'formatUser', limit: 1}).items.at(0);

		if (symbol === undefined) {
			throw new Error('Expected formatUser symbol');
		}

		appendFileSync(path.join(fixture.config.rootDir, 'src', 'models.ts'), '\nexport const addedAfterIndex = 1;\n');
		const {index} = fixture;
		expect(() => index.readSymbol({symbolId: symbol.id, contextLines: 0})).toThrow(StaleFileError);

		const rebuild = await index.ensureReady();
		expect(rebuild.reused).toBe(false);
		expect(index.readSymbol({symbolId: symbol.id, contextLines: 0})).toMatchObject({path: 'src/models.ts'});

		const unchanged = await index.ensureReady();
		expect(unchanged.reused).toBe(true);
	});

	it('reports freshness metadata on every query result', () => {
		fixture = createFixtureIndex('simple-project');
		const {index} = fixture;
		const found = index.findSymbols({query: 'formatUser', limit: 1});
		const symbolId = found.items.map((item) => item.id).at(0) ?? 'missing';

		expect(found.freshness).toMatchObject({state: 'current', dirtyFileCount: 0});
		expect(index.getStatus().refresh).toBe('current');
		expect(index.findReferences({symbolId, limit: 1}).freshness.state).toBe('current');
		expect(index.getOutline({path: 'src/models.ts', limit: 1}).freshness.state).toBe('current');
		expect(index.readSymbol({symbolId, contextLines: 0}).freshness.state).toBe('current');
	});

	it('reports unindexed files explicitly', () => {
		fixture = createFixtureIndex('simple-project');
		const {index} = fixture;

		expect(() => index.getOutline({path: 'src/missing.ts', limit: 10})).toThrow(CodeIndexError);
		expect(() => index.getOutline({path: '../outside.ts', limit: 10})).toThrow(CodeIndexError);
	});

	it('recovers after indexed files are deleted', async () => {
		fixture = createFixtureIndex('simple-project');
		rmSync(path.join(fixture.config.rootDir, 'src', 'summary.ts'));
		rmSync(path.join(fixture.config.rootDir, 'shared', 'contracts.ts'));

		const rebuild = await fixture.index.ensureReady();

		expect(rebuild.reused).toBe(false);
		expect(rebuild.fileCount).toBe(2);
		expect(fixture.index.getStatus().counts.files).toBe(2);
	});

	it('indexes imported files outside the tsconfig include', async () => {
		fixture = createFixtureIndex('simple-project');

		const result = fixture.index.findSymbols({query: 'SharedContract', limit: 10});

		expect(result.items[0]).toMatchObject({
			name: 'SharedContract',
			kind: 'type',
			path: 'shared/contracts.ts',
		});

		const unchanged = await fixture.index.ensureReady();
		expect(unchanged.reused).toBe(true);
	});

	it('reports status with scope, counts, and freshness', () => {
		fixture = createFixtureIndex('simple-project');

		const status = fixture.index.getStatus();

		expect(status.ready).toBe(true);
		expect(status.counts.files).toBe(4);
		expect(status.counts.symbols).toBeGreaterThan(0);
		expect(status.freshness.staleFiles).toBe(0);
		expect(status.freshness.sourceChanged).toBe(false);
		expect(status.exclusions.length).toBeGreaterThan(0);
	});
});
