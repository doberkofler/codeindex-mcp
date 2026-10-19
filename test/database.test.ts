import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {IndexDatabase} from '../src/core/storage/database.ts';

const file = {
	path: 'src/example.ts',
	absolutePath: '/tmp/example.ts',
	sha256: 'a'.repeat(64),
	byteCount: 0,
	lineCount: 3,
};

const symbol = {
	id: 'symbol-1',
	name: 'example',
	qualifiedName: 'example',
	kind: 'variable',
	path: file.path,
	startLine: 1,
	startColumn: 1,
	endLine: 1,
	endColumn: 20,
	startOffset: 0,
	endOffset: 19,
	enclosingId: null,
};

const occurrence = {
	symbolId: symbol.id,
	path: file.path,
	startLine: 1,
	startColumn: 14,
	endLine: 1,
	endColumn: 21,
	startOffset: 13,
	endOffset: 20,
	role: 'definition' as const,
	enclosingId: null,
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
		database.insertFiles(generationId, [file]);
		database.insertSymbols(generationId, [symbol]);
		database.insertOccurrences(generationId, [occurrence]);
		database.verifyIntegrity();
		database.publish(generationId);

		expect(database.getPublishedGeneration()).toMatchObject({
			id: generationId,
			state: 'published',
			fileCount: 1,
			symbolCount: 1,
			occurrenceCount: 1,
		});
		expect(database.findReferences({generationId, symbolId: symbol.id, role: undefined, limit: 10, offset: 0})).toHaveLength(1);

		database.close();

		const reopened = IndexDatabase.open(databasePath);

		expect(reopened.getPublishedGeneration()?.id).toBe(generationId);
		expect(reopened.getSymbol(generationId, symbol.id)?.name).toBe('example');
		reopened.close();
	});

	it('registers and releases process ownership', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-db-'));
		const database = IndexDatabase.open(path.join(directory, 'index.sqlite'));
		const ownerFiles = (): readonly string[] => readdirSync(directory).filter((name) => name.includes('.owner-'));

		expect(ownerFiles()).toHaveLength(1);
		database.close();
		expect(ownerFiles()).toHaveLength(0);
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
		database.insertFiles(generationId, [file]);
		database.insertDependencyEdges(generationId, [
			{
				id: 'edge-1',
				sourcePath: file.path,
				targetPath: null,
				rawSpecifier: 'lodash',
				normalizedPackage: 'lodash',
				kind: 'import',
				typeOnly: false,
				startLine: 1,
				startColumn: 1,
				endLine: 1,
				endColumn: 10,
				startOffset: 0,
				endOffset: 9,
			},
		]);
		database.insertDependencyBindings(generationId, [
			{edgeId: 'edge-1', position: 0, kind: 'named', importedName: 'debounce', exportedName: null, localName: 'debounce', typeOnly: false},
		]);
		database.verifyIntegrity();
		database.publish(generationId);

		expect(database.findDependencyEdgesByPackage(generationId, 'lodash')).toHaveLength(1);
		expect(database.listDependencyBindings(generationId, ['edge-1'])[0]).toMatchObject({importedName: 'debounce', localName: 'debounce'});
		expect(database.getPublishedGeneration()).toMatchObject({dependencyEdgeCount: 1, dependencyBindingCount: 1});
		database.close();
	});
});
