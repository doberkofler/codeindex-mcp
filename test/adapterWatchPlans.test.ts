import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

import {oracleExtractor, scanOracleFacts} from '@codeindex/adapter-oracle/index';
import {typeScriptExtractor} from '@codeindex/adapter-typescript/index';
import {scanProject as scanTypeScriptProject} from '@codeindex/adapter-typescript/scanProject';
import {describe, expect, it} from 'vitest';

import {routeWatchEvent} from '../src/core/freshness/workspaceWatcher.ts';
import {adapterTargets, type AdapterTargetType} from '../src/core/generation/adapterBuild.ts';
import {createAdapterWatchPlans, mergeAdapterWatchPlans, watchPlansMatchTargets} from '../src/core/generation/adapterWatchPlans.ts';
import {testAdaptersFor} from './helpers/adapters.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

describe('official adapter watch plans', () => {
	it('routes TypeScript authored, imported, configuration, manifest, and lock inputs without declaration or generated false positives', () => {
		const fixture = createFixtureConfig('input-manifest');

		try {
			const importedPath = path.join(fixture.config.rootDir, 'outside', 'imported.ts');
			mkdirSync(path.dirname(importedPath), {recursive: true});
			writeFileSync(importedPath, 'export const imported = true;\n');
			const scan = scanTypeScriptProject(fixture.config, ['outside/imported.ts']);
			const plan = typeScriptExtractor.createWatchPlan(fixture.config, scan);

			expect(plan.scopes.map((scope) => scope.candidateRoots)).toStrictEqual([['src']]);
			expect(routeWatchEvent([plan], 'change', 'src/main.ts')?.adapterIds).toStrictEqual(['typescript']);
			expect(routeWatchEvent([plan], 'change', 'outside/imported.ts')?.adapterIds).toStrictEqual(['typescript']);
			expect(routeWatchEvent([plan], 'change', 'tsconfig.json')?.paths).toBeNull();
			expect(routeWatchEvent([plan], 'change', 'package.json')?.paths).toBeNull();
			expect(routeWatchEvent([plan], 'change', 'pnpm-lock.yaml')?.paths).toBeNull();
			expect(routeWatchEvent([plan], 'change', 'src/ambient.d.ts')).toStrictEqual({
				paths: null,
				adapterIds: ['typescript'],
			});
			expect(routeWatchEvent([plan], 'add', 'src/generated/new.ts')).toBeNull();
			expect(routeWatchEvent([plan], 'add', 'src/Generated/new.ts')).toBeNull();
			expect(routeWatchEvent([plan], 'add', 'outside/new.ts')).toBeNull();
			expect(routeWatchEvent([plan], 'addDir', 'outside/new-directory')).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	it('keeps an explicitly empty TypeScript include set empty', () => {
		const fixture = createFixtureConfig('input-manifest');

		try {
			writeFileSync(fixture.config.projectFilePath, '{"compilerOptions":{"noEmit":true},"include":[]}\n');
			const plan = typeScriptExtractor.createWatchPlan(fixture.config, null);
			const scope = plan.scopes.at(0);

			expect(scope?.candidateRoots).toStrictEqual([]);
			expect(scope?.includeRules).toStrictEqual([]);
			expect(routeWatchEvent([plan], 'add', 'src/new.ts')).toBeNull();
			expect(routeWatchEvent([plan], 'addDir', 'src/new-directory')).toBeNull();
			expect(routeWatchEvent([plan], 'change', 'tsconfig.json')?.paths).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	it('routes Oracle manifest includes while excluding generated and outside files', () => {
		const fixture = createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

		try {
			const scan = scanOracleFacts(fixture.config);
			const plan = oracleExtractor.createWatchPlan(fixture.config, scan);

			expect(plan.scopes.map((scope) => scope.candidateRoots)).toStrictEqual([['database']]);
			expect(routeWatchEvent([plan], 'change', 'database/hr_api.pkb')?.adapterIds).toStrictEqual(['oracle']);
			expect(routeWatchEvent([plan], 'change', 'oracle-index.json')?.paths).toBeNull();
			expect(routeWatchEvent([plan], 'add', 'database/generated/new.pkb')).toBeNull();
			expect(routeWatchEvent([plan], 'add', 'outside/new.pkb')).toBeNull();
			expect(routeWatchEvent([plan], 'addDir', 'outside/new-directory')).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	it('preserves exact Oracle manifest glob semantics', () => {
		const fixture = createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

		try {
			writeFileSync(
				fixture.config.projectFilePath,
				JSON.stringify({
					schemaVersion: 1,
					dialect: '19c',
					defaultSchema: 'APP',
					extensions: ['.pkb'],
					include: ['database/**/*.pkb'],
					exclude: ['database/generated'],
				}),
			);
			const nonRecursiveExclude = oracleExtractor.createWatchPlan(fixture.config, null);
			expect(routeWatchEvent([nonRecursiveExclude], 'add', 'database/generated/new.pkb')?.adapterIds).toStrictEqual(['oracle']);
			expect(routeWatchEvent([nonRecursiveExclude], 'addDir', 'database/generated')?.adapterIds).toStrictEqual(['oracle']);

			writeFileSync(
				fixture.config.projectFilePath,
				JSON.stringify({
					schemaVersion: 1,
					dialect: '19c',
					defaultSchema: 'APP',
					extensions: ['.pkb'],
					include: ['database'],
					exclude: [],
				}),
			);
			const exactInclude = oracleExtractor.createWatchPlan(fixture.config, null);
			expect(routeWatchEvent([exactInclude], 'add', 'database/new.pkb')).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});
});

describe('watch-plan roster validation', () => {
	it('rejects mismatched plan identities and incomplete replacement rosters', () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const targets = adapterTargets(fixture.config, testAdaptersFor(fixture.config));
			const target = targets.at(0);

			if (target === undefined) {
				throw new Error('Expected one configured adapter target');
			}

			const plans = createAdapterWatchPlans(fixture.config, targets, null);
			expect(watchPlansMatchTargets(plans, targets)).toBe(true);
			expect(mergeAdapterWatchPlans(plans, [], targets)).toStrictEqual(plans);
			expect(() => mergeAdapterWatchPlans([], [], targets)).toThrow('Watch-plan roster does not cover every configured adapter');

			const mismatchedTarget: AdapterTargetType = {
				...target,
				extractor: {...target.extractor, version: 'mismatched-version'},
			};
			expect(() => createAdapterWatchPlans(fixture.config, [mismatchedTarget], null)).toThrow(
				'Adapter typescript returned a watch plan with mismatched identity',
			);
		} finally {
			fixture.cleanup();
		}
	});
});
