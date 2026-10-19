import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it} from 'vitest';
import {type IndexedSymbolType, type SourceFileType} from '../src/core/model.ts';
import {createSourceFileRecord} from '../src/core/generation/sourceFiles.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';

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

const symbolAt = (name: string, pathName: string, index: number): IndexedSymbolType => ({
	id: `symbol-${name}-${index}`,
	name,
	qualifiedName: name,
	kind: 'variable',
	path: pathName,
	startLine: index + 1,
	startColumn: 1,
	endLine: index + 1,
	endColumn: 10,
	startOffset: index * 20,
	endOffset: index * 20 + 5,
	enclosingId: null,
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
		database.insertFiles('generation-1', files);
		database.verifyIntegrity();

		expect(database.contentVersionCount()).toBe(1);
		expect(database.listFiles('generation-1')).toHaveLength(2);
		database.close();
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

	it('refuses publication without an unexpired build lease', async () => {
		const database = open();
		const generationId = 'generation-lease';
		database.createGeneration(generation(generationId));
		expect(database.tryAcquireBuildLease('owner-a', process.pid, 50)).toBe(true);
		await delay(60);

		expect(() => database.publish(generationId, undefined, undefined, 'owner-a')).toThrow(/lease/u);
		expect(database.tryAcquireBuildLease('owner-b', process.pid, 5_000)).toBe(true);
		expect(() => database.publish(generationId, undefined, undefined, 'owner-a')).toThrow(/lease/u);
		expect(database.getPublishedGeneration()).toBeNull();

		database.publish(generationId, undefined, undefined, 'owner-b');
		expect(database.getPublishedGeneration()?.id).toBe(generationId);
		database.close();
	});

	it('uses intended indexes for hot statements', () => {
		const database = open();
		const pathName = 'src/hot.ts';
		const file: SourceFileType = {
			path: pathName,
			absolutePath: '/tmp/hot.ts',
			sha256: 'a'.repeat(64),
			byteCount: 0,
			lineCount: 1,
		};
		database.createGeneration(generation('generation-1'));
		database.insertFiles('generation-1', [file]);
		database.insertSymbols(
			'generation-1',
			Array.from({length: 100}, (_value, index) => symbolAt(`symbol${index}`, pathName, index)),
		);

		const outlinePlan = database.explainQueryPlan('select id from symbol where generation_id = ? and path = ? order by start_offset, id limit ? offset ?', [
			'generation-1',
			pathName,
			10,
			0,
		]);
		const referencePlan = database.explainQueryPlan(
			'select path from occurrence where generation_id = ? and symbol_id = ? order by path, start_offset, role limit ? offset ?',
			['generation-1', 'symbol-symbol0-0', 10, 0],
		);

		expect(outlinePlan.join('\n')).toContain('symbol_by_path');
		expect(referencePlan.join('\n')).toContain('sqlite_autoindex_occurrence_1');
		database.close();
	});
});
