import {mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {createGenerationFactSeed} from './helpers/generationFacts.ts';

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
