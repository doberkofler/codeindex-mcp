import {closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {SCHEMA_VERSION} from '../src/core/storage/schema.ts';

let directory: string | undefined;

const databasePath = (): string => {
	directory = mkdtempSync(path.join(tmpdir(), 'code-index-quick-check-'));
	return path.join(directory, 'index.sqlite');
};

const cleanupTest = (): void => {
	vi.restoreAllMocks();
	if (directory !== undefined) {
		rmSync(directory, {recursive: true, force: true});
	}
	directory = undefined;
};

describe('database startup quick check', () => {
	afterEach(cleanupTest);

	it('runs exactly once when opening an existing valid database', () => {
		const file = databasePath();
		const original = IndexDatabase.open(file, {projectId: 'quick-check'});
		original.close();
		const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
		const reopened = IndexDatabase.open(file, {projectId: 'quick-check'});

		expect(prepare.mock.calls.filter(([sql]) => sql.toLowerCase().includes('quick_check'))).toHaveLength(1);
		reopened.close();
	});

	it('moves corrupt derived data aside and rebuilds', () => {
		const file = databasePath();
		const original = IndexDatabase.open(file, {projectId: 'quick-check'});
		original.close();
		const inspector = new DatabaseSync(file, {readOnly: true});
		const page = inspector.prepare("select pageno from dbstat where name = 'symbol' order by pageno limit 1").get();
		const size = inspector.prepare('pragma page_size').get();
		inspector.close();

		if (page === undefined || size === undefined || typeof page['pageno'] !== 'number' || typeof size['page_size'] !== 'number') {
			throw new Error('Expected a symbol B-tree page');
		}

		const descriptor = openSync(file, 'r+');
		writeSync(descriptor, Buffer.from([255]), 0, 1, (page['pageno'] - 1) * size['page_size']);
		closeSync(descriptor);

		const recovered = IndexDatabase.open(file, {projectId: 'quick-check'});
		expect(existsSync(`${file}.schema-${SCHEMA_VERSION}.bak`)).toBe(true);
		expect(recovered.getPublishedGeneration()).toBeNull();
		recovered.close();
	});
});
