import {existsSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {openDatabaseConnections} from '../src/core/storage/databaseOpen.ts';
import {WAL_AUTOCHECKPOINT_PAGES, walSizeLimitBytes} from '../src/core/storage/walPolicy.ts';
import {publishGeneration} from './helpers/statistics.ts';

const databasePathOf = (): Readonly<{directory: string; databasePath: string}> => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-wal-'));

	return {directory, databasePath: path.join(directory, 'index.sqlite')};
};

const walBytesOf = (databasePath: string): number => (existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0);

describe('write-ahead-log policy', () => {
	it('applies the declared journal limit and autocheckpoint on every writer', () => {
		const {directory, databasePath} = databasePathOf();
		const {writer, reader} = openDatabaseConnections(databasePath, path.join(directory, 'workspace'));

		try {
			const limit = writer.prepare('pragma journal_size_limit').get();
			const autocheckpoint = writer.prepare('pragma wal_autocheckpoint').get();
			const pageCount = writer.prepare('pragma page_count').get();
			const pageSize = writer.prepare('pragma page_size').get();
			const databaseBytes = Number(pageCount?.['page_count']) * Number(pageSize?.['page_size']);

			expect(limit?.['journal_size_limit']).toBe(walSizeLimitBytes(databaseBytes));
			expect(autocheckpoint?.['wal_autocheckpoint']).toBe(WAL_AUTOCHECKPOINT_PAGES);
		} finally {
			reader.close();
			writer.close();
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('holds the WAL to the declared bound after publication and a quiescent period', () => {
		const {directory, databasePath} = databasePathOf();
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

		try {
			publishGeneration(database, 'generation-1', 2000);
			const bound = walSizeLimitBytes(database.databaseSizeBytes());
			const observed = database.checkpoint();

			expect(observed.truncated).toBe(true);
			expect(walBytesOf(databasePath)).toBeLessThanOrEqual(bound);
		} finally {
			database.close();
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('defers truncation while a reader pins a snapshot, then reclaims the WAL', () => {
		const {directory, databasePath} = databasePathOf();
		const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});
		const blocker = new DatabaseSync(databasePath, {readOnly: true});
		let blockerOpen = true;

		try {
			blocker.exec('begin');
			blocker.prepare('select count(*) as total from metadata').get();
			publishGeneration(database, 'generation-1', 2000);

			expect(walBytesOf(databasePath)).toBeGreaterThan(0);

			blocker.exec('commit');
			blocker.close();
			blockerOpen = false;
			const observed = database.checkpoint();

			expect(observed.truncated).toBe(true);
			expect(walBytesOf(databasePath)).toBe(0);
		} finally {
			if (blockerOpen) {
				blocker.close();
			}

			database.close();
			rmSync(directory, {recursive: true, force: true});
		}
	});
});
