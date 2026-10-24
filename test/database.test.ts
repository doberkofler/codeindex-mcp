import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {findSymbols} from '../src/core/query/queryService.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {bindingCandidateQuery, outlinePageQuerySql, referencePageQuery} from '../src/core/storage/databasePublicationQueries.ts';
import {explainQueryPlan} from '../src/core/storage/databaseOpen.ts';
import {createDerivedGenerationFactSeed, createGenerationFactSeed} from './helpers/generationFacts.ts';
import {assertCompleteStatistics, assertIndexedPlan, publishGeneration, publishNewGeneration, queryContextOf} from './helpers/statistics.ts';

const file = {
	path: 'src/example.ts',
	absolutePath: '/tmp/example.ts',
	sha256: 'a'.repeat(64),
	byteCount: 0,
	lineCount: 3,
};

describe('IndexDatabase', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('publishes, reopens, and serves one generation', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-db-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath);
		const generationId = 'generation-1';

		database.createGeneration({
			id: generationId,
			extractorId: 'typescript',
			extractorVersion: '0.1.0',
			compilerVersion: '6.0.3',
			sourceHash: 'source',
			configHash: 'config',
		});
		database.insertGenerationFacts({generationId, ...createGenerationFactSeed()});
		database.verifyIntegrity();
		database.publish(generationId);

		expect(database.getPublishedGeneration()).toMatchObject({
			id: generationId,
			state: 'published',
			fileCount: 1,
			symbolCount: 1,
			occurrenceCount: 1,
		});
		expect(database.findReferenceRows({generationId, symbolId: 'symbol-0', limit: 10, offset: 0})).toHaveLength(1);

		database.close();

		const reopened = IndexDatabase.open(databasePath);

		expect(reopened.getPublishedGeneration()?.id).toBe(generationId);
		expect(reopened.getSymbol(generationId, 'symbol-0')?.name).toBe('example0');
		reopened.close();
	});

	it('does not publish a failed generation', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-db-'));
		const database = IndexDatabase.open(path.join(directory, 'index.sqlite'));

		database.createGeneration({
			id: 'failed-generation',
			extractorId: 'typescript',
			extractorVersion: '0.1.0',
			compilerVersion: '6.0.3',
			sourceHash: 'source',
			configHash: 'config',
		});
		database.markFailed('failed-generation', 'boom');

		expect(database.getPublishedGeneration()).toBeNull();
		expect(database.getGeneration('failed-generation')?.state).toBe('failed');
		database.close();
	});

	it('retains one superseded generation and deletes older ones', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-db-'));
		const database = IndexDatabase.open(path.join(directory, 'index.sqlite'));

		for (const id of ['generation-1', 'generation-2', 'generation-3']) {
			database.createGeneration({
				id,
				extractorId: 'typescript',
				extractorVersion: '0.1.0',
				compilerVersion: '6.0.3',
				sourceHash: id,
				configHash: id,
			});
			database.publish(id);
		}

		expect(database.getPublishedGeneration()?.id).toBe('generation-3');
		expect(database.getGeneration('generation-2')?.state).toBe('superseded');
		expect(database.getGeneration('generation-1')).toBeNull();
		database.close();
	});
});

describe('IndexDatabase identity', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('registers and releases process ownership', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'code-index-db-'));
		directory = root;
		const database = IndexDatabase.open(path.join(root, 'index.sqlite'));
		const ownerFiles = (): readonly string[] => readdirSync(root).filter((name) => name.includes('.owner-'));

		expect(ownerFiles()).toHaveLength(1);
		database.close();
		expect(ownerFiles()).toHaveLength(0);
	});

	it('persists only workspace-relative identity paths', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-db-'));
		const rootDir = path.join(directory, 'workspace');
		mkdirSync(rootDir);
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath, {
			rootDir,
			projectFilePath: path.join(rootDir, 'tsconfig.json'),
			projectId: 'project',
		});

		database.close();

		const reader = new DatabaseSync(databasePath, {readOnly: true});
		const workingCopy = reader.prepare('select canonical_root from working_copy limit 1').get();
		const project = reader.prepare('select project_file from indexed_project limit 1').get();

		reader.close();
		expect(workingCopy).toMatchObject({canonical_root: '.'});
		expect(project).toMatchObject({project_file: 'tsconfig.json'});
		expect(JSON.stringify([workingCopy, project])).not.toContain(directory);
	});
});

describe('IndexDatabase dependencies', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('persists dependency edges and bindings', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-db-'));
		const database = IndexDatabase.open(path.join(directory, 'index.sqlite'));
		const generationId = 'generation-1';

		database.createGeneration({
			id: generationId,
			extractorId: 'typescript',
			extractorVersion: '0.1.0',
			compilerVersion: '6.0.3',
			sourceHash: 'source',
			configHash: 'config',
		});
		const dependencies = {
			edges: [
				{
					id: 'edge-1',
					sourcePath: file.path,
					targetPath: null,
					rawTarget: 'lodash',
					targetIdentifier: 'lodash',
					kind: 'import',
					compileTimeOnly: false,
					startLine: 1,
					startColumn: 1,
					endLine: 1,
					endColumn: 10,
					startOffset: 0,
					endOffset: 9,
				},
			],
			bindings: [{edgeId: 'edge-1', position: 0, kind: 'named', importedName: 'debounce', exportedName: null, localName: 'debounce', compileTimeOnly: false}],
		};
		database.insertGenerationFacts({generationId, ...createGenerationFactSeed({dependencies})});
		database.verifyIntegrity();
		database.publish(generationId);

		expect(database.findDependencyEdgesByTargetIdentifier(generationId, 'lodash')).toHaveLength(1);
		expect(database.listDependencyBindings(generationId, ['edge-1'])[0]).toMatchObject({importedName: 'debounce', localName: 'debounce'});
		expect(database.getPublishedGeneration()).toMatchObject({dependencyEdgeCount: 1, dependencyBindingCount: 1});
		database.close();
	});
});

describe('IndexDatabase statistics and concurrency', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('publishes derived exposure, declared-site, and first-in-symbol columns', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

		try {
			database.createGeneration({
				id: 'generation-1',
				extractorId: 'typescript',
				extractorVersion: '0.1.0',
				compilerVersion: '6.0.3',
				sourceHash: 'derived-source',
				configHash: 'derived-config',
			});
			database.insertGenerationFacts({generationId: 'generation-1', ...createDerivedGenerationFactSeed()});
			database.publish('generation-1');
			assertCompleteStatistics(databasePath);

			const reader = new DatabaseSync(databasePath, {readOnly: true});

			try {
				const bindings = reader
					.prepare('select symbol_id, exposure, has_declared_site from symbol_name order by symbol_id')
					.all()
					.map((row) => ({
						symbolId: String(row['symbol_id']),
						exposure: String(row['exposure']),
						hasDeclaredSite: Number(row['has_declared_site']),
					}));
				const sites = reader
					.prepare('select symbol_id, path, start_offset, first_in_symbol from definition_site order by symbol_id, path, start_offset')
					.all()
					.map((row) => ({
						symbolId: String(row['symbol_id']),
						path: String(row['path']),
						startOffset: Number(row['start_offset']),
						firstInSymbol: Number(row['first_in_symbol']),
					}));

				expect(bindings).toStrictEqual([
					{symbolId: 'symbol-0', exposure: 'published', hasDeclaredSite: 1},
					{symbolId: 'symbol-1', exposure: 'reachable', hasDeclaredSite: 0},
					{symbolId: 'symbol-2', exposure: 'internal', hasDeclaredSite: 1},
				]);

				const groups = new Map<string, typeof sites>();

				for (const site of sites) {
					const key = `${site.symbolId}\u0000${site.path}`;
					const group = groups.get(key) ?? [];
					group.push(site);
					groups.set(key, group);
				}

				for (const [key, group] of groups) {
					const firsts = group.filter((site) => site.firstInSymbol === 1);
					const minimum = Math.min(...group.map((site) => site.startOffset));

					expect({
						stage: 'definition_site.first_in_symbol',
						group: key,
						firstCount: firsts.length,
						firstOffset: firsts[0]?.startOffset ?? null,
						minimumOffset: minimum,
					}).toStrictEqual({
						stage: 'definition_site.first_in_symbol',
						group: key,
						firstCount: 1,
						firstOffset: minimum,
						minimumOffset: minimum,
					});
				}

				expect(sites.filter((site) => site.symbolId === 'symbol-0').map((site) => site.startOffset)).toStrictEqual([50, 100]);
			} finally {
				reader.close();
			}
		} finally {
			database.close();
		}
	});
});

describe('IndexDatabase multi-process statistics', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('plans against fresh statistics while a reader stays open across another process publication', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');

		publishNewGeneration(databasePath, 'generation-1', 20);
		const reader = new DatabaseSync(databasePath, {readOnly: true});
		const scriptPath = path.join(directory, 'publish-child.mjs');
		const databaseModulePath = pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'core', 'storage', 'database.ts')).href;
		const helperModulePath = pathToFileURL(path.resolve(import.meta.dirname, 'helpers', 'generationFacts.ts')).href;
		const childSource = `import {IndexDatabase} from ${JSON.stringify(databaseModulePath)};
import {createGenerationFactSeed} from ${JSON.stringify(helperModulePath)};

const [databasePath, generationId, symbolCount] = process.argv.slice(2);

if (databasePath === undefined || generationId === undefined || symbolCount === undefined) {
	throw new Error('Missing child publication arguments');
}

const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

try {
	database.createGeneration({
		id: generationId,
		extractorId: 'typescript',
		extractorVersion: '0.1.0',
		compilerVersion: '6.0.3',
		sourceHash: generationId,
		configHash: generationId,
	});
	database.insertGenerationFacts({generationId, ...createGenerationFactSeed({symbolCount: Number(symbolCount)})});
	database.publish(generationId);
} finally {
	database.close();
}
`;

		try {
			writeFileSync(scriptPath, childSource, 'utf8');
			const child = spawnSync(process.execPath, ['--experimental-strip-types', scriptPath, databasePath, 'generation-2', '1200'], {
				encoding: 'utf8',
				timeout: 30_000,
			});

			expect({stage: 'statistics.publisher_process', status: child.status, stderr: child.stderr.trim()}).toStrictEqual({
				stage: 'statistics.publisher_process',
				status: 0,
				stderr: '',
			});
			assertCompleteStatistics(databasePath);

			for (const offset of [0, 1190]) {
				const candidate = bindingCandidateQuery({
					generationId: 'generation-2',
					query: 'example',
					match: 'name',
					exposure: 'visible',
					fetchLimit: 10,
				});
				const outlinePlan = explainQueryPlan(reader, outlinePageQuerySql(0), ['generation-2', 'src/example.ts', 10, offset]);
				const candidatePlan = explainQueryPlan(reader, candidate.sql, candidate.parameters);
				const reference = referencePageQuery({generationId: 'generation-2', symbolId: 'symbol-0', limit: 10, offset});
				const referencePlan = explainQueryPlan(reader, reference.sql, reference.parameters);

				assertIndexedPlan(`multi_reader.find_symbol.plan.offset.${String(offset)}`, candidatePlan);
				assertIndexedPlan(`multi_reader.outline.plan.offset.${String(offset)}`, outlinePlan);
				assertIndexedPlan(`multi_reader.find_references.plan.offset.${String(offset)}`, referencePlan);
				expect(candidatePlan.join('\n')).toContain('symbol_name_by_name');
				expect(outlinePlan.join('\n')).toContain('definition_site_by_path');
				expect(referencePlan.join('\n')).toContain('sqlite_autoindex_occurrence_1');
			}
		} finally {
			reader.close();
		}
	});
});

describe('IndexDatabase page-first query regression', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('hydrates only the emitted find_symbol page symbols', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

		try {
			publishGeneration(database, 'generation-1', 1200, 'src/search.ts');
			const summaries = vi.spyOn(database, 'symbolSummaries');
			const details = vi.spyOn(database, 'bindingDetails');
			const definitions = vi.spyOn(database, 'definitionSites');
			const result = findSymbols(queryContextOf(database, 'generation-1'), {query: 'example', limit: 5}, 32_768);
			const pageIds = result.items.map((item) => item.symbolId);
			const summaryIds = summaries.mock.calls.flatMap((call) => call[1]);
			const detailIds = details.mock.calls.flatMap((call) => call[0].symbolIds);
			const definitionIds = definitions.mock.calls.flatMap((call) => call[0].symbolIds);

			expect(pageIds).toHaveLength(5);
			expect({stage: 'find_symbol.symbol_summaries', hydrated: summaryIds}).toStrictEqual({stage: 'find_symbol.symbol_summaries', hydrated: pageIds});
			expect({stage: 'find_symbol.binding_details', hydrated: detailIds}).toStrictEqual({stage: 'find_symbol.binding_details', hydrated: pageIds});
			expect({stage: 'find_symbol.definition_sites', hydrated: definitionIds}).toStrictEqual({stage: 'find_symbol.definition_sites', hydrated: pageIds});
		} finally {
			database.close();
		}
	});

	it('pages outline from path-local first definition sites at every depth', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});
		const pathName = 'src/derived.ts';

		try {
			database.createGeneration({
				id: 'generation-1',
				extractorId: 'typescript',
				extractorVersion: '0.1.0',
				compilerVersion: '6.0.3',
				sourceHash: 'derived-source',
				configHash: 'derived-config',
			});
			database.insertGenerationFacts({generationId: 'generation-1', ...createDerivedGenerationFactSeed()});
			database.publish('generation-1');
			const reader = new DatabaseSync(databasePath, {readOnly: true});

			try {
				for (const offset of [0, 2]) {
					const sql = outlinePageQuerySql(0);
					const plan = explainQueryPlan(reader, sql, ['generation-1', pathName, 10, offset]);
					const rows = reader
						.prepare(sql)
						.all('generation-1', pathName, 10, offset)
						.map((row) => Number(row['start_offset']));

					expect(plan.join('\n')).toContain('definition_site_by_path');
					assertIndexedPlan(`outline.page.plan.offset.${String(offset)}`, plan);
					expect({stage: `outline.page_rows.offset.${String(offset)}`, offsets: rows}).toStrictEqual({
						stage: `outline.page_rows.offset.${String(offset)}`,
						offsets: offset === 0 ? [50, 150, 250] : [250],
					});
				}
			} finally {
				reader.close();
			}
		} finally {
			database.close();
		}
	});
});
