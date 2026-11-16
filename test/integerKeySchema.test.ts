import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {scopedFactIdOf} from '../src/core/storage/factIdentity.ts';
import {SCHEMA_VERSION} from '../src/core/storage/schema.ts';
import {createGenerationFactSeed} from './helpers/generationFacts.ts';

let directory: string | undefined;

const open = (): Readonly<{database: IndexDatabase; databasePath: string}> => {
	directory = mkdtempSync(path.join(tmpdir(), 'code-index-integer-schema-'));
	const databasePath = path.join(directory, 'index.sqlite');

	return {database: IndexDatabase.open(databasePath, {projectId: 'integer-schema'}), databasePath};
};

const columnsOf = (reader: DatabaseSync, table: string): readonly string[] =>
	reader
		.prepare(`pragma table_info(${table})`)
		.all()
		.map((row) => String(row['name']));

const cleanup = (): void => {
	if (directory !== undefined) {
		rmSync(directory, {recursive: true, force: true});
	}

	directory = undefined;
};

describe('integer-key storage schema', () => {
	afterEach(cleanup);

	it('uses the single coordinated schema bump and narrow child relationships', () => {
		const {database, databasePath} = open();
		database.close();
		const reader = new DatabaseSync(databasePath, {readOnly: true});

		try {
			expect(SCHEMA_VERSION).toBe('19');
			expect(columnsOf(reader, 'generation')).toStrictEqual(expect.arrayContaining(['generation_key', 'id']));
			expect(columnsOf(reader, 'generation_adapter')).toStrictEqual(expect.arrayContaining(['generation_key', 'revision']));
			expect(columnsOf(reader, 'file')).toStrictEqual(expect.arrayContaining(['file_key', 'generation_key', 'path']));
			expect(columnsOf(reader, 'project_context')).toStrictEqual(expect.arrayContaining(['context_key', 'generation_key']));
			expect(columnsOf(reader, 'symbol')).toStrictEqual(expect.arrayContaining(['symbol_key', 'generation_key', 'file_key', 'enclosing_symbol_key']));
			expect(columnsOf(reader, 'symbol')).not.toStrictEqual(expect.arrayContaining(['path', 'enclosing_id']));
			expect(columnsOf(reader, 'symbol_name')).toStrictEqual(expect.arrayContaining(['symbol_name_key', 'generation_key', 'symbol_key', 'binding_id']));
			expect(columnsOf(reader, 'symbol_name')).not.toContain('symbol_id');
			expect(columnsOf(reader, 'occurrence')).toStrictEqual(
				expect.arrayContaining(['occurrence_key', 'generation_key', 'symbol_key', 'file_key', 'path_order', 'symbol_id_order', 'enclosing_symbol_key']),
			);
			expect(columnsOf(reader, 'occurrence')).not.toStrictEqual(expect.arrayContaining(['symbol_id', 'path', 'enclosing_id']));
			expect(columnsOf(reader, 'occurrence_context')).toStrictEqual(['occurrence_key', 'context_key']);
			expect(columnsOf(reader, 'definition_site')).toStrictEqual(
				expect.arrayContaining(['generation_key', 'site_id', 'occurrence_key', 'symbol_key', 'symbol_id_order', 'file_key']),
			);
			expect(columnsOf(reader, 'dependency_edge')).toStrictEqual(
				expect.arrayContaining(['edge_key', 'generation_key', 'context_key', 'source_file_key', 'target_file_key']),
			);
			expect(columnsOf(reader, 'dependency_edge')).not.toStrictEqual(expect.arrayContaining(['context_name', 'source_path', 'target_path']));
			expect(columnsOf(reader, 'dependency_binding')).toStrictEqual(
				expect.arrayContaining(['edge_key', 'position', 'kind', 'imported_name', 'exported_name', 'local_name', 'compile_time_only']),
			);
			expect(columnsOf(reader, 'dependency_binding')).not.toStrictEqual(expect.arrayContaining(['generation_id', 'adapter_id', 'edge_id']));
		} finally {
			reader.close();
		}
	});
});

describe('integer-key storage relationships', () => {
	afterEach(cleanup);

	it('stores public identities once and preserves them across integer joins', () => {
		const {database, databasePath} = open();
		const generationId = 'public-generation';
		const seed = createGenerationFactSeed({
			dependencies: {
				edges: [
					{
						id: 'edge-1',
						context: 'app',
						sourcePath: 'src/example.ts',
						targetPath: 'src/example.ts',
						rawTarget: './example',
						targetIdentifier: null,
						kind: 'import',
						compileTimeOnly: false,
						startLine: 1,
						startColumn: 1,
						endLine: 1,
						endColumn: 2,
						startOffset: 0,
						endOffset: 1,
					},
				],
				bindings: [
					{
						edgeId: 'edge-1',
						position: 0,
						kind: 'named',
						importedName: 'example0',
						exportedName: null,
						localName: 'example0',
						compileTimeOnly: false,
					},
				],
			},
		});
		database.createGeneration({id: generationId, sourceHash: 'source', configHash: 'config'});
		database.insertGenerationFacts({generationId, ...seed});
		database.verifyIntegrity();
		database.close();

		const reader = new DatabaseSync(databasePath, {readOnly: true});

		try {
			const row = reader
				.prepare(
					`select g.id as generation_id, s.id as symbol_id, f.path, o.start_offset, d.site_id,
						e.id as edge_id, source.path as source_path, target.path as target_path, b.position
					 from definition_site d
					 join generation g on g.generation_key = d.generation_key
					 join occurrence o on o.occurrence_key = d.occurrence_key
					 join symbol s on s.symbol_key = o.symbol_key
					 join file f on f.file_key = o.file_key
					 join dependency_edge e on e.generation_key = g.generation_key
					 join file source on source.file_key = e.source_file_key
					 left join file target on target.file_key = e.target_file_key
					 join dependency_binding b on b.edge_key = e.edge_key`,
				)
				.get();

			expect(row).toMatchObject({
				generation_id: generationId,
				symbol_id: scopedFactIdOf(seed.adapterId, 'symbol-0'),
				path: 'src/example.ts',
				site_id: expect.stringMatching(/^o_/u),
				edge_id: scopedFactIdOf(seed.adapterId, 'edge-1'),
				source_path: 'src/example.ts',
				target_path: 'src/example.ts',
				position: 0,
			});
		} finally {
			reader.close();
		}
	});
});

describe('integer-key diagnostic relationships', () => {
	afterEach(cleanup);

	it('retains paths that do not identify an indexed file', () => {
		const {database, databasePath} = open();
		const generationId = 'diagnostic-path-generation';
		const seed = createGenerationFactSeed();
		database.createGeneration({id: generationId, sourceHash: 'source', configHash: 'config'});
		database.insertGenerationFacts({
			generationId,
			...seed,
			diagnostics: [
				{category: 'error', code: 1, message: 'indexed', path: 'src/example.ts', startLine: 1, startColumn: 1},
				{category: 'error', code: 2, message: 'unindexed', path: 'tsconfig.json', startLine: 1, startColumn: 1},
				{category: 'error', code: 3, message: 'global', path: null, startLine: null, startColumn: null},
			],
		});
		database.close();

		const reader = new DatabaseSync(databasePath, {readOnly: true});

		try {
			expect(
				reader
					.prepare(
						`select d.code, coalesce(f.path, d.fallback_path) path, d.file_key, d.fallback_path
						 from diagnostic d left join file f on f.file_key = d.file_key
						 order by d.position`,
					)
					.all()
					.map((row) => ({...row})),
			).toStrictEqual([
				{code: 1, path: 'src/example.ts', file_key: expect.any(Number), fallback_path: null},
				{code: 2, path: 'tsconfig.json', file_key: null, fallback_path: 'tsconfig.json'},
				{code: 3, path: null, file_key: null, fallback_path: null},
			]);
		} finally {
			reader.close();
		}
	});
});

describe('integer-key public ordering', () => {
	afterEach(cleanup);

	it('preserves public identifier ordering when integer insertion order differs', () => {
		const {database} = open();
		const generationId = 'ordered-generation';
		const seed = createGenerationFactSeed({symbolCount: 2});
		const symbolsDescending = [...seed.facts.symbols].sort((left, right) =>
			scopedFactIdOf(seed.adapterId, right.id).localeCompare(scopedFactIdOf(seed.adapterId, left.id)),
		);
		const occurrencesBySymbol = new Map(seed.facts.occurrences.map((occurrence) => [occurrence.symbolId, occurrence]));
		const facts = {
			...seed.facts,
			symbols: symbolsDescending.map((symbol) => ({
				...symbol,
				startLine: 1,
				endLine: 1,
				startOffset: 13,
				endOffset: 20,
			})),
			occurrences: symbolsDescending.map((symbol) => {
				const occurrence = occurrencesBySymbol.get(symbol.id);

				if (occurrence === undefined) {
					throw new Error(`Missing occurrence for ${symbol.id}`);
				}

				return {
					...occurrence,
					startLine: 1,
					endLine: 1,
					startOffset: 13,
					endOffset: 20,
					extent: {
						startLine: 1,
						startColumn: 1,
						endLine: 1,
						endColumn: 21,
						startOffset: 0,
						endOffset: 20,
					},
				};
			}),
		};
		const expectedIds = seed.facts.symbols.map((symbol) => scopedFactIdOf(seed.adapterId, symbol.id)).sort();
		database.createGeneration({id: generationId, sourceHash: 'source', configHash: 'config'});
		database.insertGenerationFacts({generationId, ...seed, facts});

		expect(database.outlineSymbols({generationId, path: 'src/example.ts', kinds: [], limit: 10, offset: 0}).map((entry) => entry.symbol.id)).toStrictEqual(
			expectedIds,
		);
		expect(
			database
				.findReferenceRows({
					generationId,
					symbolId: expectedIds[0] ?? '',
					symbolIds: expectedIds,
					limit: 10,
					offset: 0,
				})
				.map((reference) => reference.symbolId),
		).toStrictEqual(expectedIds);
		database.close();
	});
});

describe('integer-key dependency relationships', () => {
	afterEach(cleanup);

	it('retains a dependency edge when only its target file is deleted', () => {
		const {database, databasePath} = open();
		const generationId = 'dependency-target-generation';
		const seed = createGenerationFactSeed({
			dependencies: {
				edges: [
					{
						id: 'edge-1',
						context: 'app',
						sourcePath: 'src/example.ts',
						targetPath: 'src/target.ts',
						rawTarget: './target',
						targetIdentifier: null,
						kind: 'import',
						compileTimeOnly: false,
						startLine: 1,
						startColumn: 1,
						endLine: 1,
						endColumn: 2,
						startOffset: 0,
						endOffset: 1,
					},
				],
				bindings: [],
			},
		});
		const files = [...seed.files, {path: 'src/target.ts', absolutePath: '/tmp/target.ts', sha256: 'b'.repeat(64), byteCount: 0, lineCount: 0}];
		database.createGeneration({id: generationId, sourceHash: 'source', configHash: 'config'});
		database.insertGenerationFacts({generationId, ...seed, files});
		database.close();

		const writer = new DatabaseSync(databasePath);

		try {
			writer.exec('pragma foreign_keys = on');
			writer
				.prepare(
					`delete from file
					 where generation_key = (select generation_key from generation where id = ?) and path = ?`,
				)
				.run(generationId, 'src/target.ts');
			expect(
				writer
					.prepare(
						`select e.id, e.target_file_key from dependency_edge e
						 where e.generation_key = (select generation_key from generation where id = ?)`,
					)
					.get(generationId),
			).toMatchObject({id: scopedFactIdOf(seed.adapterId, 'edge-1'), target_file_key: null});
		} finally {
			writer.close();
		}
	});
});

describe('integer-key index replacement', () => {
	afterEach(cleanup);

	it('omits indexes duplicated by unique constraints', () => {
		const {database, databasePath} = open();
		database.close();
		const reader = new DatabaseSync(databasePath, {readOnly: true});

		try {
			const names = reader
				.prepare("select name from sqlite_master where type = 'index' and name in ('occurrence_by_definition_site', 'symbol_name_by_symbol')")
				.all();

			expect(names).toStrictEqual([]);
		} finally {
			reader.close();
		}
	});
});
