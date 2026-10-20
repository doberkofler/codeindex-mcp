import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {createGenerationFactSeed, type GenerationFactSeedType} from './helpers/generationFacts.ts';

type GenerationRowType = Readonly<{
	id: string;
	extractorId: string;
	extractorVersion: string;
	compilerVersion: string;
	sourceHash: string;
	configHash: string;
}>;

const generation = (id: string): GenerationRowType => ({
	id,
	extractorId: 'typescript',
	extractorVersion: '0.1.0',
	compilerVersion: '6.0.3',
	sourceHash: id,
	configHash: id,
});

const withBindingIds = (seed: GenerationFactSeedType, bindingIds: readonly string[]): GenerationFactSeedType => ({
	...seed,
	facts: {
		...seed.facts,
		bindings: seed.facts.bindings.map((binding, index) => ({...binding, bindingId: bindingIds[index] ?? binding.bindingId})),
		bindingContexts: seed.facts.bindingContexts.map((context, index) => ({...context, bindingId: bindingIds[index] ?? context.bindingId})),
		bindingSites: seed.facts.bindingSites.map((site, index) => ({...site, bindingId: bindingIds[index] ?? site.bindingId})),
	},
});

const duplicateFirstBinding = (seed: GenerationFactSeedType): GenerationFactSeedType => {
	const first = seed.facts.bindings.at(0);

	if (first === undefined) {
		throw new Error('Expected a seeded binding');
	}

	return withBindingIds(
		seed,
		seed.facts.bindings.map(() => first.bindingId),
	);
};

let directory: string | undefined;

const cleanupDirectory = (): void => {
	if (directory !== undefined) {
		rmSync(directory, {recursive: true, force: true});
	}

	directory = undefined;
};

const open = (): Readonly<{database: IndexDatabase; databasePath: string}> => {
	directory = mkdtempSync(path.join(tmpdir(), 'code-index-facts-'));
	const databasePath = path.join(directory, 'index.sqlite');

	return {database: IndexDatabase.open(databasePath, {projectId: 'facts-test'}), databasePath};
};

describe('generation fact persistence', () => {
	afterEach(cleanupDirectory);

	it('persists deterministic identifiers for the same fact set', () => {
		const {database, databasePath} = open();
		const first = createGenerationFactSeed({symbolCount: 3});
		const second = createGenerationFactSeed({symbolCount: 3});

		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...first});
		database.createGeneration(generation('generation-2'));
		database.insertGenerationFacts({generationId: 'generation-2', ...second});
		database.close();

		const reader = new DatabaseSync(databasePath, {readOnly: true});
		const bindings = reader
			.prepare('select binding_id, symbol_id, binding_key from symbol_name where generation_id = ? order by binding_id')
			.all('generation-1');
		const sites = reader
			.prepare('select site_id, symbol_id, path, start_offset from definition_site where generation_id = ? order by site_id')
			.all('generation-1');
		const repeatedBindings = reader
			.prepare('select binding_id, symbol_id, binding_key from symbol_name where generation_id = ? order by binding_id')
			.all('generation-2');
		const repeatedSites = reader
			.prepare('select site_id, symbol_id, path, start_offset from definition_site where generation_id = ? order by site_id')
			.all('generation-2');
		reader.close();

		expect(bindings).toHaveLength(3);
		expect(bindings).toStrictEqual(repeatedBindings);
		expect(sites).toStrictEqual(repeatedSites);
	});

	it('leaves no foreign-key or coverage violation in a persisted generation', () => {
		const {database, databasePath} = open();
		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed({symbolCount: 4})});
		database.verifyIntegrity();
		database.close();

		const reader = new DatabaseSync(databasePath, {readOnly: true});
		const uncovered = reader
			.prepare(
				`select count(*) as total from occurrence o
				 left join definition_site d on d.generation_id = o.generation_id and d.symbol_id = o.symbol_id
				 and d.path = o.path and d.start_offset = o.start_offset and d.role = o.role
				 where o.generation_id = ? and o.role = 'definition' and d.site_id is null`,
			)
			.get('generation-1');
		reader.close();

		expect(uncovered).toMatchObject({total: 0});
	});

	it('enforces foreign keys on persisted child rows', () => {
		const {database, databasePath} = open();
		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed()});
		database.close();

		const writer = new DatabaseSync(databasePath);
		writer.exec('pragma foreign_keys = on');

		try {
			expect(() =>
				writer
					.prepare(
						"insert into symbol_name_context (generation_id, binding_id, context_name, exposure) values ('generation-1', 'b_missing', 'app', 'published')",
					)
					.run(),
			).toThrow(/FOREIGN KEY/u);
		} finally {
			writer.close();
		}
	});

	it('scopes status counts to one generation', () => {
		const {database} = open();
		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed({symbolCount: 1})});
		database.createGeneration(generation('generation-2'));
		database.insertGenerationFacts({generationId: 'generation-2', ...createGenerationFactSeed({symbolCount: 3})});

		expect(database.countRows('generation-1', 'symbol')).toBe(1);
		expect(database.countRows('generation-2', 'symbol')).toBe(3);
		expect(database.countRows('generation-1', 'symbol_name')).toBe(1);
		expect(database.countRows('generation-2', 'symbol_name')).toBe(3);
		expect(database.countRows('generation-1', 'definition_site')).toBe(1);
		expect(database.countRows('generation-2', 'definition_site')).toBe(3);
		database.close();
	});
});

describe('generation fact failure isolation', () => {
	afterEach(cleanupDirectory);

	it('fails a colliding binding identifier and rolls the candidate back', () => {
		const {database} = open();
		const seed = createGenerationFactSeed({symbolCount: 2});

		database.createGeneration(generation('generation-1'));

		expect(() => database.insertGenerationFacts({generationId: 'generation-1', ...duplicateFirstBinding(seed)})).toThrow(/UNIQUE|constraint/u);
		expect(database.countRows('generation-1', 'symbol')).toBe(0);
		expect(database.countRows('generation-1', 'symbol_name')).toBe(0);
		database.close();
	});

	it('isolates a failed candidate from the published generation', () => {
		const {database} = open();
		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed()});
		database.publish('generation-1');

		database.createGeneration(generation('generation-2'));

		expect(() => database.insertGenerationFacts({generationId: 'generation-2', ...duplicateFirstBinding(createGenerationFactSeed({symbolCount: 2}))})).toThrow(
			/UNIQUE|constraint/u,
		);
		database.markFailed('generation-2', 'synthetic collision');

		expect(database.getPublishedGeneration()?.id).toBe('generation-1');
		expect(database.getGeneration('generation-2')?.state).toBe('failed');
		expect(database.countRows('generation-2', 'symbol')).toBe(0);
		database.close();
	});
});
