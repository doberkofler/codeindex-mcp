import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it} from 'vitest';
import {type SourceFileType} from '../src/core/model.ts';
import {createSourceFileRecord} from '../src/core/generation/sourceFiles.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {renewLease} from '../src/core/storage/databaseLease.ts';
import {REQUIRED_PLANNER_STATISTICS} from '../src/core/storage/databaseStatistics.ts';
import {bindingCandidateQuery, outlinePageQuerySql, referencePageQuery} from '../src/core/storage/databasePublicationQueries.ts';
import {explainQueryPlan} from '../src/core/storage/databaseOpen.ts';
import {createGenerationFactSeed} from './helpers/generationFacts.ts';
import {assertCompleteStatistics, assertIndexedPlan, publishGeneration, publishNewGeneration, statisticsOf} from './helpers/statistics.ts';

type GenerationInputType = Readonly<{
	id: string;
	extractorId: string;
	extractorVersion: string;
	compilerVersion: string;
	sourceHash: string;
	configHash: string;
}>;

const generation = (id: string): GenerationInputType => ({
	id,
	extractorId: 'typescript',
	extractorVersion: '0.1.0',
	compilerVersion: '6.0.3',
	sourceHash: id,
	configHash: id,
});

describe('index storage identity and content', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('persists one working-copy identity across restarts', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));
		const root = path.join(directory, 'workspace');
		const databasePath = path.join(directory, 'index.sqlite');
		const first = IndexDatabase.open(databasePath, {rootDir: root, projectId: 'storage-test'});
		const identity = first.getWorkingCopy();
		first.close();

		const second = IndexDatabase.open(databasePath, {rootDir: root, projectId: 'storage-test'});

		expect(identity).not.toBeNull();
		expect(second.getWorkingCopy()?.id).toBe(identity?.id);
		second.close();
	});

	it('assigns different identities to separate checkouts', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));
		const first = IndexDatabase.open(path.join(directory, 'first.sqlite'), {projectId: 'storage-test'});
		const second = IndexDatabase.open(path.join(directory, 'second.sqlite'), {projectId: 'storage-test'});

		expect(first.getWorkingCopy()?.id).toBeDefined();
		expect(first.getWorkingCopy()?.id).not.toBe(second.getWorkingCopy()?.id);
		first.close();
		second.close();
	});

	it('deduplicates identical content while keeping distinct file identities', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));
		const root = path.join(directory, 'workspace');
		const database = IndexDatabase.open(path.join(directory, 'index.sqlite'), {rootDir: root, projectId: 'storage-test'});
		const content = 'export const shared = 1;\n';
		const firstPath = path.join(root, 'src', 'first.ts');
		const secondPath = path.join(root, 'src', 'second.ts');
		mkdirSync(path.dirname(firstPath), {recursive: true});
		writeFileSync(firstPath, content);
		writeFileSync(secondPath, content);
		const files: readonly SourceFileType[] = [createSourceFileRecord(firstPath, root), createSourceFileRecord(secondPath, root)];

		database.createGeneration(generation('generation-1'));
		database.insertContents(files);
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed({path: 'src/first.ts'}), files});
		database.verifyIntegrity();

		expect(database.contentVersionCount()).toBe(1);
		expect(database.listFiles('generation-1')).toHaveLength(2);
		database.close();
	});

	it('keeps the first extraction artifact for one content identity', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));
		const root = path.join(directory, 'workspace');
		const filePath = path.join(root, 'src', 'artifact.ts');
		mkdirSync(path.dirname(filePath), {recursive: true});
		writeFileSync(filePath, 'export const artifact = 1;\n');
		const file = createSourceFileRecord(filePath, root);
		const database = IndexDatabase.open(path.join(directory, 'index.sqlite'), {rootDir: root, projectId: 'storage-test'});
		const identity = {
			contentSha256: file.sha256,
			artifactKind: 'symbols',
			extractorId: 'typescript',
			extractorVersion: '0.1.0',
			contextHash: 'context',
		};

		database.insertContents([file]);
		database.putExtractionArtifact({...identity, artifactJson: 'first'});
		expect(database.hasExtractionArtifact(identity)).toBe(true);
		database.putExtractionArtifact({...identity, artifactJson: 'second'});

		expect(database.getExtractionArtifact(identity)).toBe('first');
		database.close();
	});

	it('indexes file content for unreferenced content cleanup', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});
		database.close();

		const reader = new DatabaseSync(databasePath, {readOnly: true});
		const plan = explainQueryPlan(reader, 'select 1 from file where content_sha256 = ?', ['hash']).join(' ');
		reader.close();

		expect(plan).toContain('file_by_content');
	});

	it('backs up an incompatible schema and rebuilds the database', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const raw = new DatabaseSync(databasePath);
		raw.exec("create table metadata (key text primary key, value text not null); insert into metadata (key, value) values ('schema_version', '1')");
		raw.close();

		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

		expect(existsSync(`${databasePath}.schema-1.bak`)).toBe(true);
		expect(database.getWorkingCopy()).not.toBeNull();
		database.close();
	});

	it('propagates an access failure instead of moving the database aside', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));
		const databasePath = path.join(directory, 'index.sqlite');
		mkdirSync(databasePath);

		// macOS reports SQLITE_IOERR for a directory, Linux SQLITE_CANTOPEN; both are access failures.
		expect(() => IndexDatabase.open(databasePath, {projectId: 'storage-test'})).toThrow(/unable to open database file|disk I\/O error/u);
		expect(existsSync(databasePath)).toBe(true);
		expect(existsSync(`${databasePath}.schema-unknown.bak`)).toBe(false);
	});
});

describe('index storage coordination and plans', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	const open = (): IndexDatabase => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-storage-'));

		return IndexDatabase.open(path.join(directory, 'index.sqlite'), {projectId: 'storage-test'});
	};

	it('allows exactly one build-lease owner and permits takeover after expiry', async () => {
		const database = open();

		expect(database.tryAcquireBuildLease('owner-a', process.pid, 50)).toBe(true);
		expect(database.tryAcquireBuildLease('owner-b', process.pid, 50)).toBe(false);
		expect(database.renewBuildLease('owner-a', 50)).toBe(true);
		expect(database.getBuildLease()?.ownerId).toBe('owner-a');

		await delay(60);

		expect(database.tryAcquireBuildLease('owner-b', process.pid, 50)).toBe(true);
		expect(database.getBuildLease()?.ownerId).toBe('owner-b');
		database.releaseBuildLease('owner-b');
		expect(database.getBuildLease()).toBeNull();
		database.close();
	});

	it('renews the same owner lease at publication after expiry', async () => {
		const database = open();
		const generationId = 'generation-lease-renew';
		database.createGeneration(generation(generationId));
		expect(database.tryAcquireBuildLease('owner-a', process.pid, 50)).toBe(true);
		await delay(60);

		database.publish(generationId, undefined, undefined, 'owner-a');
		expect(database.getPublishedGeneration()?.id).toBe(generationId);
		database.close();
	});

	it('refuses publication after another owner takes over', async () => {
		const database = open();
		const generationId = 'generation-lease-takeover';
		database.createGeneration(generation(generationId));
		expect(database.tryAcquireBuildLease('owner-a', process.pid, 50)).toBe(true);
		await delay(60);
		expect(database.tryAcquireBuildLease('owner-b', process.pid, 5000)).toBe(true);

		expect(() => database.publish(generationId, undefined, undefined, 'owner-a')).toThrow(/taken over/u);
		expect(database.getPublishedGeneration()).toBeNull();

		database.publish(generationId, undefined, undefined, 'owner-b');
		expect(database.getPublishedGeneration()?.id).toBe(generationId);
		database.close();
	});

	it('treats a locked writer as a skipped lease renewal', () => {
		const database = open();
		expect(database.tryAcquireBuildLease('owner-a', process.pid, 5000)).toBe(true);
		database.close();

		if (directory === undefined) {
			throw new Error('Missing test directory');
		}

		const databasePath = path.join(directory, 'index.sqlite');
		const renewer = new DatabaseSync(databasePath);
		renewer.exec('pragma busy_timeout = 0');
		const blocker = new DatabaseSync(databasePath);
		blocker.exec('begin immediate');

		try {
			expect(renewLease(renewer, {projectId: 'storage-test', ownerId: 'owner-a', ttlMs: 5000})).toBe(false);
		} finally {
			blocker.exec('rollback');
			blocker.close();
			renewer.close();
		}
	});

	it('uses intended indexes for hot statements at every depth', () => {
		const database = open();
		const pathName = 'src/hot.ts';
		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed({symbolCount: 100, path: pathName})});

		const candidate = bindingCandidateQuery({
			generationId: 'generation-1',
			query: 'example',
			match: 'name',
			exposure: 'visible',
			fetchLimit: 10,
		});

		for (const offset of [0, 90]) {
			const outlinePlan = database.explainQueryPlan(outlinePageQuerySql(0), ['generation-1', pathName, 10, offset]);
			const candidatePlan = database.explainQueryPlan(candidate.sql, candidate.parameters);
			const referencePlan = database.explainQueryPlan(
				referencePageQuery({generationId: 'generation-1', symbolId: 'symbol-0', limit: 10, offset}).sql,
				referencePageQuery({generationId: 'generation-1', symbolId: 'symbol-0', limit: 10, offset}).parameters,
			);

			expect(outlinePlan.join('\n')).toContain('definition_site_by_path');
			expect(outlinePlan.some((line) => line.startsWith('SCAN'))).toBe(false);
			expect(candidatePlan.join('\n')).toContain('symbol_name_by_name');
			expect(candidatePlan.some((line) => line.startsWith('SCAN'))).toBe(false);
			expect(referencePlan.join('\n')).toContain('SEARCH o USING INDEX');
			expect(referencePlan.some((line) => line.startsWith('SCAN'))).toBe(false);
		}

		database.close();
	});
});

describe('index storage query-planner statistics', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('writes complete statistics for the correlated exposure lookup at publication', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');

		publishNewGeneration(databasePath, 'generation-1', 20);

		// The correlated exposure subquery in symbol search seeks this index by
		// (generation_id, binding_id). Without a row estimate SQLite instead scans
		// the whole generation through symbol_name_context_by_exposure for every
		// candidate row, which costs seconds per page on a large index.
		expect(statisticsOf(databasePath, 'symbol_name_context', 'sqlite_autoindex_symbol_name_context_1')).toMatch(/^20\b/u);
		assertCompleteStatistics(databasePath);
	});

	it('keeps statistics complete through empty start, growth, rebuild, and watcher-style publication', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

		try {
			// An empty database has no estimates for unpublished application rows.
			// Metadata and working-copy bookkeeping rows may still have their own.
			expect(REQUIRED_PLANNER_STATISTICS.filter((requirement) => statisticsOf(databasePath, requirement.table, requirement.index) !== null)).toStrictEqual([]);
			assertCompleteStatistics(databasePath);

			publishGeneration(database, 'generation-1', 20);
			assertCompleteStatistics(databasePath);
			const small = Number(statisticsOf(databasePath, 'symbol_name', 'symbol_name_by_name')?.split(' ')[0]);
			expect(small).toBe(20);

			// Small-to-large replacement keeps the previous generation only as the
			// superseded row set, so the statistic must follow the new total.
			publishGeneration(database, 'generation-2', 1200);
			assertCompleteStatistics(databasePath);
			const large = Number(statisticsOf(databasePath, 'symbol_name', 'symbol_name_by_name')?.split(' ')[0]);
			expect(large).toBeGreaterThan(small);

			// Forced rebuild and the watcher refresh both publish through the same
			// transaction, so each must refresh the estimates again.
			publishGeneration(database, 'generation-3', 1200);
			assertCompleteStatistics(databasePath);
			publishGeneration(database, 'generation-4', 40, 'src/watched.ts');
			assertCompleteStatistics(databasePath);
		} finally {
			database.close();
		}
	});

	it('repairs selected missing statistics rows on open', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');

		publishNewGeneration(databasePath, 'generation-1', 20);
		const raw = new DatabaseSync(databasePath);
		raw.exec(
			`delete from sqlite_stat1
			 where (tbl = 'symbol_name' and idx = 'symbol_name_by_name')
			    or (tbl = 'definition_site' and idx = 'definition_site_by_path')
			    or (tbl = 'occurrence' and idx = 'sqlite_autoindex_occurrence_1')`,
		);
		raw.close();

		expect(statisticsOf(databasePath, 'symbol_name', 'symbol_name_by_name')).toBeNull();
		expect(statisticsOf(databasePath, 'definition_site', 'definition_site_by_path')).toBeNull();
		expect(statisticsOf(databasePath, 'occurrence', 'sqlite_autoindex_occurrence_1')).toBeNull();

		IndexDatabase.open(databasePath, {projectId: 'storage-test'}).close();

		expect(statisticsOf(databasePath, 'symbol_name', 'symbol_name_by_name')).toMatch(/^20\b/u);
		expect(statisticsOf(databasePath, 'definition_site', 'definition_site_by_path')).toMatch(/^20\b/u);
		expect(statisticsOf(databasePath, 'occurrence', 'sqlite_autoindex_occurrence_1')).toMatch(/^20\b/u);
		assertCompleteStatistics(databasePath);
	});

	it('backfills statistics for a database built without them', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');

		publishNewGeneration(databasePath, 'generation-1', 20);

		const raw = new DatabaseSync(databasePath);
		raw.exec('drop table sqlite_stat1');
		raw.close();

		IndexDatabase.open(databasePath, {projectId: 'storage-test'}).close();

		expect(statisticsOf(databasePath, 'symbol_name_context', 'sqlite_autoindex_symbol_name_context_1')).toMatch(/^20\b/u);
		assertCompleteStatistics(databasePath);
	});
});

describe('index storage hot-statement plans', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('plans hot statements without a scan or temporary B-tree at shallow and maximum depth', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});
		const pathName = 'src/hot.ts';
		const symbolCount = 100;

		try {
			publishGeneration(database, 'generation-1', symbolCount, pathName);
			assertCompleteStatistics(databasePath);

			for (const offset of [0, symbolCount - 10]) {
				const candidate = bindingCandidateQuery({
					generationId: 'generation-1',
					query: 'example',
					match: 'name',
					exposure: 'visible',
					fetchLimit: 10,
				});
				const outlinePlan = database.explainQueryPlan(outlinePageQuerySql(0), ['generation-1', pathName, 10, offset]);
				const candidatePlan = database.explainQueryPlan(candidate.sql, candidate.parameters);
				const reference = referencePageQuery({generationId: 'generation-1', symbolId: 'symbol-0', limit: 10, offset});
				const referencePlan = database.explainQueryPlan(reference.sql, reference.parameters);

				expect(outlinePlan.join('\n')).toContain('definition_site_by_path');
				expect(candidatePlan.join('\n')).toContain('symbol_name_by_name');
				expect(referencePlan.join('\n')).toContain('sqlite_autoindex_occurrence_1');
				assertIndexedPlan(`outline.plan.offset.${String(offset)}`, outlinePlan);
				assertIndexedPlan(`find_symbol.candidate.plan.offset.${String(offset)}`, candidatePlan);
				assertIndexedPlan(`find_references.page.plan.offset.${String(offset)}`, referencePlan);
			}
		} finally {
			database.close();
		}
	});
});
