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
import {explainQueryPlan} from '../src/core/storage/databaseOpen.ts';
import {createGenerationFactSeed} from './helpers/generationFacts.ts';

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

	it('uses intended indexes for hot statements', () => {
		const database = open();
		const pathName = 'src/hot.ts';
		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed({symbolCount: 100, path: pathName})});

		const outlinePlan = database.explainQueryPlan('select id from symbol where generation_id = ? and path = ? order by start_offset, id limit ? offset ?', [
			'generation-1',
			pathName,
			10,
			0,
		]);
		const referencePlan = database.explainQueryPlan(
			'select path from occurrence where generation_id = ? and symbol_id = ? order by path, start_offset, role limit ? offset ?',
			['generation-1', 'symbol-0', 10, 0],
		);

		expect(outlinePlan.join('\n')).toContain('symbol_by_path');
		expect(referencePlan.join('\n')).toContain('occurrence_by_definition_site');
		database.close();
	});
});

/**
 * Reads one recorded planner statistic.
 *
 * @param databasePath - Index database file.
 * @param table - Table the statistic belongs to.
 * @param index - Index the statistic belongs to.
 * @returns The recorded `sqlite_stat1` value, or null when absent.
 */
const statisticsOf = (databasePath: string, table: string, index: string): string | null => {
	const reader = new DatabaseSync(databasePath, {readOnly: true});

	try {
		const row = reader.prepare('select stat from sqlite_stat1 where tbl = ? and idx = ?').get(table, index);
		return row === undefined ? null : String(row['stat']);
	} finally {
		reader.close();
	}
};

/**
 * Builds and publishes one synthetic generation.
 *
 * @param databasePath - Index database file.
 * @param symbolCount - Number of symbols to publish.
 */
const seedPublishedGeneration = (databasePath: string, symbolCount: number): void => {
	const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

	try {
		database.createGeneration(generation('generation-1'));
		database.insertGenerationFacts({generationId: 'generation-1', ...createGenerationFactSeed({symbolCount})});
		database.publish('generation-1');
	} finally {
		database.close();
	}
};

describe('index storage query-planner statistics', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('writes statistics for the correlated exposure lookup at publication', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');

		seedPublishedGeneration(databasePath, 20);

		// The correlated exposure subquery in symbol search seeks this index by
		// (generation_id, binding_id). Without statistics SQLite instead scans the
		// whole generation through symbol_name_context_by_exposure for every
		// candidate row, which costs seconds per page on a large index.
		expect(statisticsOf(databasePath, 'symbol_name_context', 'sqlite_autoindex_symbol_name_context_1')).toMatch(/^20\b/u);
	});

	it('backfills statistics for a database built without them', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-statistics-'));
		const databasePath = path.join(directory, 'index.sqlite');

		seedPublishedGeneration(databasePath, 20);

		const raw = new DatabaseSync(databasePath);
		raw.exec('drop table sqlite_stat1');
		raw.close();

		IndexDatabase.open(databasePath, {projectId: 'storage-test'}).close();

		expect(statisticsOf(databasePath, 'symbol_name_context', 'sqlite_autoindex_symbol_name_context_1')).toMatch(/^20\b/u);
	});
});
