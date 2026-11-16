import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createSourceFileRecord} from '../src/core/generation/sourceFiles.ts';
import {type AdapterCommitType, IndexDatabase} from '../src/core/storage/database.ts';
import {scopedFactIdOf} from '../src/core/storage/factIdentity.ts';
import {verifyPublishedIndex} from '../src/core/generation/verifyIndex.ts';
import {createGenerationFactSeed, type GenerationFactSeedType} from './helpers/generationFacts.ts';

const checkpointControl = vi.hoisted(() => ({fail: false}));

vi.mock(import('../src/core/storage/databaseWal.ts'), async (importOriginal) => {
	const actual = await importOriginal();

	return {
		...actual,
		checkpointWal: (writer: DatabaseSync): ReturnType<typeof actual.checkpointWal> => {
			if (checkpointControl.fail) {
				throw new Error('checkpoint failure');
			}

			return actual.checkpointWal(writer);
		},
	};
});

const PROVENANCE = {
	protocolVersion: 1,
	adapterVersion: '1.0.0',
	packageName: null,
	packageVersion: null,
	compilerVersion: 'test',
	declaredCompilerVersion: null,
	compilerDrift: false,
} as const;

let directory: string | undefined;

const seedOf = (adapterId: string, relativePath: string): GenerationFactSeedType => {
	if (directory === undefined) {
		throw new Error('Test directory is not initialized');
	}

	const absolutePath = path.join(directory, 'workspace', relativePath);
	mkdirSync(path.dirname(absolutePath), {recursive: true});
	writeFileSync(absolutePath, '');
	const seed = createGenerationFactSeed({path: relativePath});

	return {
		...seed,
		adapterId,
		language: adapterId,
		files: [createSourceFileRecord(absolutePath, path.join(directory, 'workspace'))],
	};
};

const adapterOf = (seed: GenerationFactSeedType): AdapterCommitType => ({
	adapterId: seed.adapterId,
	...PROVENANCE,
	coverage: 'present',
	absenceReason: null,
	sourceHash: `${seed.adapterId}-source`,
	configHash: `${seed.adapterId}-config`,
	inputHash: `${seed.adapterId}-input`,
	counts: {
		files: seed.files.length,
		symbols: seed.facts.symbols.length,
		occurrences: seed.facts.occurrences.length,
		dependencyEdges: seed.dependencies.edges.length,
		dependencyBindings: seed.dependencies.bindings.length,
		diagnostics: seed.diagnostics.length,
	},
	stages: {scanMs: 0, compilerMs: 0, extractionMs: 0},
	files: seed.files,
	projects: seed.projects,
	facts: seed.facts,
	dependencies: seed.dependencies,
	diagnostics: seed.diagnostics,
});

const openDatabase = (): IndexDatabase => {
	directory = mkdtempSync(path.join(tmpdir(), 'code-index-publication-hot-path-'));
	return IndexDatabase.open(path.join(directory, 'index.sqlite'), {projectId: 'publication-hot-path'});
};

const publish = (database: IndexDatabase, adapters: readonly AdapterCommitType[]): ReturnType<IndexDatabase['commitAdapters']> => {
	const generationId = 'generation';
	database.createGeneration({id: generationId, sourceHash: 'source', configHash: 'config', inputHash: 'input'});
	return database.commitAdapters({
		generationId,
		adapters,
		mode: 'insert',
		sourceHash: 'source',
		configHash: 'config',
		inputHash: 'input',
	});
};

const revise = (database: IndexDatabase, adapters: readonly AdapterCommitType[]): ReturnType<IndexDatabase['commitAdapters']> =>
	database.commitAdapters({
		generationId: 'generation',
		adapters,
		mode: 'revise',
		sourceHash: 'revised-source',
		configHash: 'revised-config',
		inputHash: 'revised-input',
	});

const cleanupTest = (): void => {
	checkpointControl.fail = false;
	vi.restoreAllMocks();
	if (directory !== undefined) {
		rmSync(directory, {recursive: true, force: true});
	}
	directory = undefined;
};

const factsOf = (adapter: AdapterCommitType): NonNullable<AdapterCommitType['facts']> => {
	if (adapter.facts === undefined) {
		throw new Error('Expected seeded facts');
	}

	return adapter.facts;
};

const firstOf = <ItemType>(items: readonly ItemType[]): ItemType => {
	const [first] = items;

	if (first === undefined) {
		throw new Error('Expected a seeded item');
	}

	return first;
};

describe('publication checks and COMMIT enforcement', () => {
	afterEach(cleanupTest);

	it.each([
		['one', ['typescript']],
		['two', ['typescript', 'oracle']],
	] as const)('executes no database-wide checks for a %s-adapter revision', (_label, adapterIds) => {
		const database = openDatabase();

		try {
			const adapters = adapterIds.map((adapterId, index) => adapterOf(seedOf(adapterId, index === 0 ? 'src/example.ts' : 'db/example.sql')));
			publish(database, adapters);
			const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');

			const report = revise(database, adapters);
			const statements = prepare.mock.calls.map(([sql]) => sql.toLowerCase());

			expect(statements.some((sql) => sql.includes('foreign_key_check') || sql.includes('quick_check'))).toBe(false);
			expect(report).toMatchObject({
				persistence: {
					changedPathCount: expect.any(Number),
					selectedRowCount: expect.any(Number),
					deletedRowCount: expect.any(Number),
					writtenRowCount: expect.any(Number),
					countValidationMs: expect.any(Number),
					semanticValidationMs: expect.any(Number),
					publicationMetadataMs: expect.any(Number),
					contentGcMs: expect.any(Number),
					plannerStatisticsMs: expect.any(Number),
					commitMs: expect.any(Number),
					publicationCheckpoint: {
						durationMs: expect.any(Number),
						busy: expect.any(Boolean),
						logFrames: expect.any(Number),
						checkpointedFrames: expect.any(Number),
					},
					totalWallMs: expect.any(Number),
				},
			});
		} finally {
			database.close();
		}
	});

	it('rejects a deferred FK violation at COMMIT and preserves the prior publication', () => {
		const database = openDatabase();

		try {
			const adapter = adapterOf(seedOf('typescript', 'src/example.ts'));
			const baseline = publish(database, [adapter]);
			const beforeGeneration = database.getPublishedGeneration();
			const beforeAdapters = database.getGenerationAdapters('generation');
			const facts = factsOf(adapter);
			const firstSymbol = firstOf(facts.symbols);
			const persistedSymbolId = scopedFactIdOf(adapter.adapterId, firstSymbol.id);
			const beforeSymbol = database.getSymbol('generation', persistedSymbolId);

			const malformed: AdapterCommitType = {
				...adapter,
				facts: {
					...facts,
					symbols: [{...firstSymbol, enclosingId: 'missing-parent'}, ...facts.symbols.slice(1)],
				},
			};

			expect(() => revise(database, [malformed])).toThrow(/FOREIGN KEY constraint failed/u);
			expect(database.getPublishedGeneration()).toStrictEqual(beforeGeneration);
			expect(database.getGenerationAdapters('generation')).toStrictEqual(beforeAdapters);
			expect(database.countRows('generation', 'symbol')).toBe(baseline.counts.symbols);
			expect(database.getSymbol('generation', persistedSymbolId)).toStrictEqual(beforeSymbol);

			const recovered = revise(database, [adapter]);
			expect(recovered.revision).toBe(baseline.revision + 1);
		} finally {
			database.close();
		}
	});

	it('reports a publication-checkpoint failure without reversing the committed revision', () => {
		const database = openDatabase();

		try {
			const adapter = adapterOf(seedOf('typescript', 'src/example.ts'));
			const baseline = publish(database, [adapter]);
			checkpointControl.fail = true;

			const report = revise(database, [adapter]);

			expect(report.revision).toBe(baseline.revision + 1);
			expect(report.persistence.publicationCheckpoint).toMatchObject({mode: 'failed', failed: true});
			expect(database.getPublishedGeneration()?.revision).toBe(report.revision);
		} finally {
			database.close();
		}
	});
});

describe('changed-adapter validation and explicit verification', () => {
	afterEach(cleanupTest);

	it('rolls back changed-adapter count and semantic validation failures', () => {
		const database = openDatabase();

		try {
			const adapter = adapterOf(seedOf('typescript', 'src/example.ts'));
			const baseline = publish(database, [adapter]);
			const facts = factsOf(adapter);
			const occurrence = firstOf(facts.occurrences);
			const bindingContext = firstOf(facts.bindingContexts);

			const duplicateContext: AdapterCommitType = {
				...adapter,
				facts: {
					...facts,
					occurrences: [{...occurrence, contexts: [...(occurrence.contexts ?? []), ...(occurrence.contexts ?? [])]}],
				},
			};
			expect(() => revise(database, [duplicateContext])).toThrow(/occurrence_context/u);
			expect(database.getPublishedGeneration()?.revision).toBe(baseline.revision);

			const unmatchedContext: AdapterCommitType = {
				...adapter,
				projects: [
					...adapter.projects,
					{name: 'other', projectFile: 'tsconfig.other.json', configHash: 'other', projectFileCount: 1, configDiagnosticCount: 0},
				],
				facts: {
					...facts,
					bindingContexts: [...facts.bindingContexts, {...bindingContext, context: 'other'}],
				},
			};
			expect(() => revise(database, [unmatchedContext])).toThrow(/matching symbol context/u);
			expect(database.getPublishedGeneration()?.revision).toBe(baseline.revision);
			expect(database.getGenerationAdapters('generation')).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	it('retains full integrity, FK, and metadata-count checks in explicit verification', () => {
		const database = openDatabase();

		try {
			publish(database, [adapterOf(seedOf('typescript', 'src/example.ts'))]);
			const generation = database.getPublishedGeneration();
			const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');

			if (generation === null) {
				throw new Error('Expected a published generation');
			}

			expect(verifyPublishedIndex(database, generation)).toMatchObject({integrity: 'ok', metadataMatches: true});
			const statements = prepare.mock.calls.map(([sql]) => sql.toLowerCase());
			expect(statements.some((sql) => sql.includes('integrity_check'))).toBe(true);
			expect(statements.some((sql) => sql.includes('foreign_key_check'))).toBe(true);
			expect(statements.filter((sql) => sql.includes('count(*)'))).not.toHaveLength(0);
		} finally {
			database.close();
		}
	});
});
