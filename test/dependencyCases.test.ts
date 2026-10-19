import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {CodeIndexError} from '../src/core/errors/errors.ts';
import {
	type DependencyConsumerItemType,
	type DependencyEvidenceConsumerType,
	type IndexedDependencyBindingType,
	type IndexedDependencyEdgeType,
} from '../src/core/model.ts';
import {createFixtureIndex, type FixtureContextType} from './helpers/fixture.ts';

const evidenceOf = (item: DependencyConsumerItemType | undefined): DependencyEvidenceConsumerType | undefined =>
	item !== undefined && 'evidence' in item ? item : undefined;

const edgeFacts = (edge: IndexedDependencyEdgeType): Readonly<Record<string, unknown>> => ({
	sourcePath: edge.sourcePath,
	targetPath: edge.targetPath,
	rawTarget: edge.rawTarget,
	targetIdentifier: edge.targetIdentifier,
	kind: edge.kind,
	compileTimeOnly: edge.compileTimeOnly,
});

const bindingFacts = (bindings: readonly IndexedDependencyBindingType[]): readonly Readonly<Record<string, unknown>>[] =>
	bindings.map(({kind, importedName, exportedName, localName, compileTimeOnly}) => ({kind, importedName, exportedName, localName, compileTimeOnly}));

const edgeAt = (edges: readonly IndexedDependencyEdgeType[], sourcePath: string): IndexedDependencyEdgeType => {
	const edge = edges.find((candidate) => candidate.sourcePath === sourcePath);

	if (edge === undefined) {
		throw new Error(`Expected dependency edge from ${sourcePath}`);
	}

	return edge;
};

const dependencyKey = (item: DependencyConsumerItemType): string => `${item.directRoot}\u0000${item.path}`;

const useDependencyFixture = (): (() => FixtureContextType) => {
	let fixture: FixtureContextType | undefined;

	beforeAll(() => {
		fixture = createFixtureIndex('dependency-cases');
	});

	afterAll(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	return () => {
		if (fixture === undefined) {
			throw new Error('Dependency fixture is not initialized');
		}

		return fixture;
	};
};

const publishedGenerationId = (fixture: FixtureContextType): string => {
	const id = fixture.database.getPublishedGeneration()?.id;

	if (id === undefined) {
		throw new Error('Expected a published generation');
	}

	return id;
};

describe('controlled dependency extraction', () => {
	const context = useDependencyFixture();

	it('pins package and authored re-export edges before traversal', () => {
		const fixture = context();
		const {database} = fixture;
		const id = publishedGenerationId(fixture);
		const packageEdges = database.findDependencyEdgesByTargetIdentifier(id, 'lodash');

		expect(packageEdges.map((edge) => edgeFacts(edge))).toStrictEqual([
			{
				sourcePath: 'src/cycle/a.ts',
				targetPath: null,
				rawTarget: 'lodash',
				targetIdentifier: 'lodash',
				kind: 'import',
				compileTimeOnly: false,
			},
			{
				sourcePath: 'src/roots/direct.ts',
				targetPath: null,
				rawTarget: 'lodash',
				targetIdentifier: 'lodash',
				kind: 'import',
				compileTimeOnly: false,
			},
			{
				sourcePath: 'src/roots/inner.ts',
				targetPath: null,
				rawTarget: 'lodash',
				targetIdentifier: 'lodash',
				kind: 'import',
				compileTimeOnly: false,
			},
			{
				sourcePath: 'src/roots/reexport.ts',
				targetPath: null,
				rawTarget: 'lodash',
				targetIdentifier: 'lodash',
				kind: 'export',
				compileTimeOnly: false,
			},
		]);

		const packageReexport = edgeAt(packageEdges, 'src/roots/reexport.ts');

		expect(bindingFacts(database.listDependencyBindings(id, [packageReexport.id]))).toStrictEqual([
			{kind: 'named', importedName: 'debounce', exportedName: 'debounce', localName: null, compileTimeOnly: false},
		]);

		const authoredEdges = database.findDependencyEdgesByTargets(id, ['src/roots/inner.ts']);

		expect(authoredEdges.map((edge) => edgeFacts(edge))).toStrictEqual([
			{
				sourcePath: 'src/roots/barrel.ts',
				targetPath: 'src/roots/inner.ts',
				rawTarget: './inner.js',
				targetIdentifier: null,
				kind: 'export-all',
				compileTimeOnly: false,
			},
			{
				sourcePath: 'src/roots/named.ts',
				targetPath: 'src/roots/inner.ts',
				rawTarget: './inner.js',
				targetIdentifier: null,
				kind: 'export',
				compileTimeOnly: false,
			},
		]);

		expect(bindingFacts(database.listDependencyBindings(id, [edgeAt(authoredEdges, 'src/roots/barrel.ts').id]))).toStrictEqual([
			{kind: 'all', importedName: '*', exportedName: '*', localName: null, compileTimeOnly: false},
		]);
		expect(bindingFacts(database.listDependencyBindings(id, [edgeAt(authoredEdges, 'src/roots/named.ts').id]))).toStrictEqual([
			{kind: 'named', importedName: 'work', exportedName: 'work', localName: null, compileTimeOnly: false},
		]);
	});
});

describe('controlled dependency direct usage', () => {
	const context = useDependencyFixture();

	it('returns compact direct package usage in deterministic order', () => {
		const {index} = context();
		const result = index.findDependencies({target: 'lodash', limit: 50});

		expect(result.queryMeaning).toBe('direct_usage');
		expect(result.items).toStrictEqual([
			{path: 'src/cycle/a.ts', depth: 1, directRoot: 'src/cycle/a.ts'},
			{path: 'src/roots/direct.ts', depth: 1, directRoot: 'src/roots/direct.ts'},
			{path: 'src/roots/inner.ts', depth: 1, directRoot: 'src/roots/inner.ts'},
			{path: 'src/roots/reexport.ts', depth: 1, directRoot: 'src/roots/reexport.ts'},
		]);
		expect(result.summary).toStrictEqual({
			totalConsumers: 4,
			directConsumers: 4,
			transitiveConsumers: 0,
			roots: [],
		});
	});
});

describe('controlled dependency module impact', () => {
	const context = useDependencyFixture();

	it('traverses authored re-exports and keeps every shortest direct root', () => {
		const {index} = context();
		const result = index.findDependencies({target: 'lodash', transitive: true, limit: 100});

		expect(result.queryMeaning).toBe('dependency_impact');
		expect(result.items.map(({directRoot, path, depth}) => ({directRoot, path, depth}))).toStrictEqual([
			{directRoot: 'src/cycle/a.ts', path: 'src/cycle/a.ts', depth: 1},
			{directRoot: 'src/cycle/a.ts', path: 'src/cycle/b.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/roots/direct.ts', depth: 1},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page01.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page02.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page03.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page04.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page05.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page06.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page07.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page08.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page09.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page10.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page11.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/page12.ts', depth: 2},
			{directRoot: 'src/roots/direct.ts', path: 'src/consumers/shared.ts', depth: 2},
			{directRoot: 'src/roots/inner.ts', path: 'src/roots/inner.ts', depth: 1},
			{directRoot: 'src/roots/inner.ts', path: 'src/roots/barrel.ts', depth: 2},
			{directRoot: 'src/roots/inner.ts', path: 'src/roots/named.ts', depth: 2},
			{directRoot: 'src/roots/inner.ts', path: 'src/consumers/unusedBinding.ts', depth: 3},
			{directRoot: 'src/roots/inner.ts', path: 'src/consumers/viaBarrel.ts', depth: 3},
			{directRoot: 'src/roots/inner.ts', path: 'src/consumers/viaNamed.ts', depth: 3},
			{directRoot: 'src/roots/reexport.ts', path: 'src/roots/reexport.ts', depth: 1},
			{directRoot: 'src/roots/reexport.ts', path: 'src/consumers/shared.ts', depth: 2},
		]);
		expect(result.items.filter((item) => item.path === 'src/cycle/b.ts')).toHaveLength(1);
		expect(
			result.items
				.filter((item) => item.path === 'src/consumers/shared.ts')
				.map((item) => item.directRoot)
				.sort(),
		).toStrictEqual(['src/roots/direct.ts', 'src/roots/reexport.ts']);
		expect(result.summary).toStrictEqual({
			totalConsumers: 23,
			directConsumers: 4,
			transitiveConsumers: 19,
			roots: [
				{path: 'src/cycle/a.ts', consumerCount: 2},
				{path: 'src/roots/direct.ts', consumerCount: 14},
				{path: 'src/roots/inner.ts', consumerCount: 6},
				{path: 'src/roots/reexport.ts', consumerCount: 2},
			],
		});
	});

	it('keeps re-export evidence and filters impact to one direct root', () => {
		const {index} = context();
		const result = index.findDependencies({
			target: 'lodash',
			transitive: true,
			root: 'src/roots/inner.ts',
			detail: 'evidence',
			limit: 100,
		});

		expect(result.items.map((item) => item.path)).toStrictEqual([
			'src/roots/inner.ts',
			'src/roots/barrel.ts',
			'src/roots/named.ts',
			'src/consumers/unusedBinding.ts',
			'src/consumers/viaBarrel.ts',
			'src/consumers/viaNamed.ts',
		]);
		expect(result.items.every((item) => item.directRoot === 'src/roots/inner.ts')).toBe(true);
		expect(result.summary).toStrictEqual({
			totalConsumers: 6,
			directConsumers: 1,
			transitiveConsumers: 5,
			roots: [{path: 'src/roots/inner.ts', consumerCount: 6}],
		});
		expect(evidenceOf(result.items.find((item) => item.path === 'src/roots/barrel.ts'))?.evidence).toMatchObject({
			targetPath: 'src/roots/inner.ts',
			rawTarget: './inner.js',
			kind: 'export-all',
		});
		expect(evidenceOf(result.items.find((item) => item.path === 'src/roots/named.ts'))?.evidence).toMatchObject({
			targetPath: 'src/roots/inner.ts',
			rawTarget: './inner.js',
			kind: 'export',
		});
		expect(evidenceOf(result.items.find((item) => item.path === 'src/consumers/viaBarrel.ts'))).toMatchObject({
			depth: 3,
			relationship: 'transitive',
			evidence: {targetPath: 'src/roots/barrel.ts', kind: 'import'},
		});
	});
});

describe('controlled dependency pagination', () => {
	const context = useDependencyFixture();

	it('paginates direct usage without losing or duplicating entries', () => {
		const {index} = context();
		const entries: DependencyConsumerItemType[] = [];
		let cursor: string | undefined;

		for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
			const page = index.findDependencies({target: 'lodash', limit: 2, cursor});

			expect(page.summary.totalConsumers).toBe(4);
			entries.push(...page.items);
			cursor = page.nextCursor ?? undefined;

			if (cursor === undefined) {
				break;
			}
		}

		const unpaged = index.findDependencies({target: 'lodash', limit: 100});

		expect(entries.map((item) => item.path)).toStrictEqual(unpaged.items.map((item) => item.path));
	});

	it('paginates grouped impact without losing or duplicating entries', () => {
		const {index} = context();
		const entries: DependencyConsumerItemType[] = [];
		let cursor: string | undefined;

		for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
			const page = index.findDependencies({target: 'lodash', transitive: true, limit: 5, cursor});

			expect(page.summary.totalConsumers).toBe(23);
			entries.push(...page.items);
			cursor = page.nextCursor ?? undefined;

			if (cursor === undefined) {
				break;
			}
		}

		const unpaged = index.findDependencies({target: 'lodash', transitive: true, limit: 100});
		const keys = entries.map((item) => dependencyKey(item));

		expect(keys).toHaveLength(24);
		expect(new Set(keys).size).toBe(24);
		expect(new Set(keys)).toStrictEqual(new Set(unpaged.items.map((item) => dependencyKey(item))));
	});

	it('rejects cursors reused with different dependency semantics', () => {
		const {index} = context();
		const firstPage = index.findDependencies({target: 'lodash', limit: 2});
		const cursor = firstPage.nextCursor ?? undefined;

		expect(cursor).toBeDefined();
		expect(() => index.findDependencies({target: 'lodash', transitive: true, limit: 2, cursor})).toThrow(CodeIndexError);
		expect(() => index.findDependencies({target: 'lodash', detail: 'evidence', limit: 2, cursor})).toThrow(CodeIndexError);
		expect(() => index.findDependencies({target: 'different', limit: 2, cursor})).toThrow(CodeIndexError);
	});
});
