import {describe, expect, it} from 'vitest';
import {typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {finalizeFacts, type FinalizedFactSetType} from '../src/core/facts/index.ts';
import {createFixtureConfig, createFixtureIndex} from './helpers/fixture.ts';

const buildFacts = (): Readonly<{facts: FinalizedFactSetType; cleanup: () => void}> => {
	const {config, cleanup} = createFixtureConfig('publication-project');
	const scan = typeScriptExtractor.scan(config, []);
	const extracted = typeScriptExtractor.build(config, scan);
	const facts = finalizeFacts(extracted, {mode: 'enforce', maxBindingsPerRoot: 2000});

	return {facts, cleanup};
};

const exposuresOf = (facts: FinalizedFactSetType): ReadonlyMap<string, string> => {
	const bindingById = new Map(facts.bindings.map((binding) => [binding.bindingId, binding]));

	return new Map(facts.bindingContexts.map((context) => [bindingById.get(context.bindingId)?.qualifiedName ?? context.bindingId, context.exposure]));
};

const EXPECTED_BINDINGS: readonly string[] = [
	'module["src/api.ts"]::api.run',
	'module["src/api.ts"]::api.nested.deep',
	'module["src/api.ts"]::hidden.m',
	'module["src/api.ts"]::load::return::awaited.ready',
	'module["src/api.ts"]::list::return::element.k',
	'module["src/api.ts"]::default::return.go',
	'module["src/alias.ts"]::exposed',
	'module["src/alias.ts"]::renamed',
	'module["src/alias.ts"]::starValue',
	'module["src/alias.ts"]::starFn',
	'module["src/inheritance.ts"]::Derived.baseOnly',
	'module["src/usage.ts"]::readValue.run',
	'module["src/usage.ts"]::callValue::awaited.ready',
	'module["src/usage.ts"]::typed.x',
];

describe('TypeScript publication vertical slice', () => {
	it('publishes public constructor parameter properties and excludes private ones', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const exposures = exposuresOf(facts);

			expect(exposures.get('module["src/parameter-property.ts"]::WithParameterProperty.value')).toBe('published');
			expect(exposures.has('module["src/parameter-property.ts"]::WithParameterProperty.hidden')).toBe(false);
		} finally {
			cleanup();
		}
	});

	it('publishes an imported namespace re-export as a namespace root', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const exposures = exposuresOf(facts);

			expect(exposures.get('module["src/namespace.ts"]::helpers')).toBe('published');
			expect(exposures.get('module["src/namespace.ts"]::helpers.starValue')).toBe('published');
		} finally {
			cleanup();
		}
	});

	it('projects surface addresses and alias roots', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const exposures = exposuresOf(facts);

			for (const name of EXPECTED_BINDINGS) {
				expect(exposures.get(name)).toBe('published');
			}

			expect(facts.issues).toStrictEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe('External alias publication', () => {
	it('records external alias targets without materializing external declarations', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const external = facts.symbols.find((symbol) => symbol.name === 'externalAlias');

			expect(external).toMatchObject({externalTarget: 'external-package', externalName: 'externalValue', exposure: 'published'});
		} finally {
			cleanup();
		}
	});

	it('classifies call, read, write, and type-reference usage bits', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const idOf = (name: string): string => {
				const symbol = facts.symbols.find((entry) => entry.name === name);

				if (symbol === undefined) {
					throw new Error(`Missing symbol ${name}`);
				}

				return symbol.id;
			};
			const usages = (name: string, pathName: string): readonly number[] =>
				facts.occurrences
					.filter((occurrence) => occurrence.symbolId === idOf(name) && occurrence.path === pathName && occurrence.role === 'reference')
					.map((occurrence) => occurrence.usage ?? 0);

			expect(usages('load', 'src/usage.ts')).toContain(1);
			expect(usages('Point', 'src/usage.ts')).toContain(8);
			expect(usages('target', 'src/usage.ts')).toContain(4);
			expect(usages('api', 'src/usage.ts')).toContain(2);
		} finally {
			cleanup();
		}
	});

	it('serves find_symbol filters and deduplicates bindings by symbol', () => {
		const fixture = createFixtureIndex('publication-project');

		try {
			const api = fixture.index.findSymbols({query: 'api', exposure: 'published', limit: 10});

			expect(api.items).toHaveLength(1);
			expect(api.items[0]).toMatchObject({name: 'api', symbolExposure: 'published'});
			expect(api.items[0]?.matched.qualifiedName).toBe('module["src/api.ts"]::api');
			expect(fixture.index.findSymbols({query: 'api', exposure: 'internal', limit: 10}).items).toHaveLength(0);

			const visible = fixture.index.findSymbols({query: 'Supporting', exposure: 'visible', limit: 10});

			expect(visible.items).toHaveLength(1);
			expect(visible.items[0]?.symbolExposure).toBe('reachable');
			expect(visible.items[0]?.primary.qualifiedName).toBe('module["src/api.ts"]::Supporting');
			expect(fixture.index.getStatus().buildStats.some((stat) => stat.metric === 'bindings')).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	it('serves binding and definition list modes plus symbol_at', () => {
		const fixture = createFixtureIndex('publication-project');

		try {
			const api = fixture.index.findSymbols({query: 'api', limit: 1}).items.at(0);

			if (api === undefined) {
				throw new Error('Missing api symbol');
			}
			const names = fixture.index.readSymbol({symbolId: api.symbolId, mode: 'names', contextLines: 0, limit: 20});
			const sites = fixture.index.readSymbol({symbolId: api.symbolId, mode: 'sites', contextLines: 0, limit: 20});
			const matched = names.kind === 'names' ? names.items[0] : undefined;

			expect(names.kind).toBe('names');
			expect(sites.kind).toBe('sites');
			expect(api.primary.bindingId).toBe(matched?.bindingId);

			if (matched === undefined) {
				throw new Error('Missing primary binding');
			}

			const bindingSites = fixture.index.readSymbol({symbolId: api.symbolId, mode: 'binding_sites', contextLines: 0, bindingId: matched.bindingId, limit: 20});
			const contexts = fixture.index.readSymbol({symbolId: api.symbolId, mode: 'binding_contexts', contextLines: 0, bindingId: matched.bindingId, limit: 20});
			const at = fixture.index.symbolAt({path: 'src/api.ts', line: 16, column: 14});

			expect(bindingSites.kind).toBe('binding_sites');
			expect(contexts.kind).toBe('binding_contexts');
			expect(at.candidates[0]?.symbol.name).toBe('api');
			expect(at.reason).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	it('keeps every cross-file reference on a published or reachable target', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const exposureById = new Map(facts.symbols.map((symbol) => [symbol.id, symbol.exposure]));
			const pathById = new Map(facts.symbols.map((symbol) => [symbol.id, symbol.path]));
			const crossFile = facts.occurrences.filter((occurrence) => occurrence.role === 'reference' && occurrence.path !== pathById.get(occurrence.symbolId));

			expect(crossFile.length).toBeGreaterThan(0);

			for (const occurrence of crossFile) {
				expect(exposureById.get(occurrence.symbolId)).not.toBe('internal_only');
			}
		} finally {
			cleanup();
		}
	});
});

describe('ESM JavaScript vertical slice', () => {
	it('serves ESM JavaScript through the same vertical slice', () => {
		const fixture = createFixtureIndex('javascript-project');

		try {
			const greet = fixture.index.findSymbols({query: 'greet', limit: 1}).items.at(0);

			if (greet === undefined) {
				throw new Error('Missing greet symbol');
			}

			expect(greet.path).toBe('src/greet.js');
			expect(greet.symbolExposure).toBe('published');

			const references = fixture.index.findReferences({symbolId: greet.symbolId, limit: 20});

			expect(references.items.some((entry) => entry.path === 'src/index.js')).toBe(true);

			const source = fixture.index.readSymbol({symbolId: greet.symbolId, contextLines: 0});
			const text = source.kind === 'text' ? source.source : '';

			expect(source.kind).toBe('text');
			expect(text).toContain('export const greet');
		} finally {
			fixture.cleanup();
		}
	});
});
