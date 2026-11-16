import {DatabaseSync} from 'node:sqlite';

import {describe, expect, it} from 'vitest';

import {typeScriptExtractor} from '@codeindex/adapter-typescript/index';

import {IndexDatabase} from '../src/core/storage/database.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

describe('watch-plan persistence', () => {
	it('restores a validated relative-path plan across database reopen', () => {
		const fixture = createFixtureConfig('simple-project');
		const context = {rootDir: fixture.config.rootDir, projectId: fixture.config.projectId};
		let database = IndexDatabase.open(fixture.config.databasePath, context);

		try {
			const plan = typeScriptExtractor.createWatchPlan(fixture.config, null);
			database.putWatchPlans([plan]);
			database.close();
			database = IndexDatabase.open(fixture.config.databasePath, context);

			expect(database.getWatchPlans()).toStrictEqual([plan]);
			expect(JSON.stringify(database.getWatchPlans())).not.toContain(fixture.config.rootDir);
		} finally {
			database.close();
			fixture.cleanup();
		}
	});

	it('falls back to bootstrap when persisted metadata is malformed', () => {
		const fixture = createFixtureConfig('simple-project');
		const context = {rootDir: fixture.config.rootDir, projectId: fixture.config.projectId};
		let database = IndexDatabase.open(fixture.config.databasePath, context);

		try {
			database.close();
			const writer = new DatabaseSync(fixture.config.databasePath);

			try {
				writer
					.prepare('insert into metadata (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
					.run('adapter_watch_plans', 'not-json');
			} finally {
				writer.close();
			}

			database = IndexDatabase.open(fixture.config.databasePath, context);
			expect(database.getWatchPlans()).toStrictEqual([]);
		} finally {
			database.close();
			fixture.cleanup();
		}
	});
});
