import {describe, expect, it} from 'vitest';

import {adapterTargets, type AdapterTargetType} from '../src/core/generation/adapterBuild.ts';
import {planAdapterScans} from '../src/core/generation/adapterRefresh.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {testAdaptersFor} from './helpers/adapters.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';

describe('adapter refresh planning', () => {
	it('records a declared optional absence without scanning', async () => {
		const fixture = createFixtureConfig('simple-project');
		const database = IndexDatabase.open(fixture.config.databasePath, {
			rootDir: fixture.config.rootDir,
			projectId: fixture.config.projectId,
		});

		try {
			const target = adapterTargets(fixture.config, testAdaptersFor(fixture.config)).at(0);

			if (target === undefined) {
				throw new Error('Expected one configured adapter target');
			}

			const optionalTarget: AdapterTargetType = {
				...target,
				adapter: {...target.adapter, required: false},
				extractor: {
					...target.extractor,
					absenceReasons: ['temporarily-unavailable'],
					probe: () => ({available: false, reason: 'temporarily-unavailable'}),
				},
			};
			const plans = await planAdapterScans({
				config: fixture.config,
				targets: [optionalTarget],
				database,
				published: null,
				logger: silentLogger,
				analytics: null,
				observed: new Set(),
			});

			expect(plans).toStrictEqual([
				{
					adapterId: 'typescript',
					coverage: 'absent',
					absenceReason: 'temporarily-unavailable',
					scan: null,
				},
			]);
		} finally {
			database.close();
			fixture.cleanup();
		}
	});

	it('rejects an undeclared absence reason', async () => {
		const fixture = createFixtureConfig('simple-project');
		const database = IndexDatabase.open(fixture.config.databasePath, {
			rootDir: fixture.config.rootDir,
			projectId: fixture.config.projectId,
		});

		try {
			const target = adapterTargets(fixture.config, testAdaptersFor(fixture.config)).at(0);

			if (target === undefined) {
				throw new Error('Expected one configured adapter target');
			}

			const invalidTarget: AdapterTargetType = {
				...target,
				adapter: {...target.adapter, required: false},
				extractor: {
					...target.extractor,
					absenceReasons: [],
					probe: () => ({available: false, reason: 'undeclared'}),
				},
			};

			await expect(
				planAdapterScans({
					config: fixture.config,
					targets: [invalidTarget],
					database,
					published: null,
					logger: silentLogger,
					analytics: null,
					observed: new Set(),
				}),
			).rejects.toThrow('Adapter typescript reported an undeclared absence reason');
		} finally {
			database.close();
			fixture.cleanup();
		}
	});
});
