import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setImmediate as immediate, setTimeout as delay} from 'node:timers/promises';

import {defineAdapterWatchPlan, type AdapterWatchPlanType} from '@codeindex/adapter-sdk';
import {describe, expect, it, vi} from 'vitest';

import {AdapterWatchController} from '../src/core/freshness/adapterWatchController.ts';
import {silentLogger} from './helpers/silentLogger.ts';

type ChangeType = Readonly<{paths: readonly string[] | null; adapterIds: readonly string[]}>;

const planOf = (adapterId: string, root: string, sourcePath: string, suffix: string): AdapterWatchPlanType =>
	defineAdapterWatchPlan({
		adapterId,
		adapterVersion: '1.0.0',
		knownSourceFiles: [sourcePath],
		inputFiles: [],
		scopes: [
			{
				candidateRoots: [root],
				includeRules: [{kind: 'glob', pattern: `${root}/**/*`}],
				excludeRules: [],
				sourceRules: [{kind: 'suffix', suffix}],
			},
		],
	});

describe('AdapterWatchController', () => {
	it('replaces physical subscriptions and reconciles only changed plan handoffs', async () => {
		const rootDir = mkdtempSync(path.join(tmpdir(), 'code-index-watch-controller-'));
		const typescriptPath = path.join(rootDir, 'src', 'main.ts');
		const oraclePath = path.join(rootDir, 'database', 'demo.pkb');
		mkdirSync(path.dirname(typescriptPath), {recursive: true});
		mkdirSync(path.dirname(oraclePath), {recursive: true});
		writeFileSync(typescriptPath, 'export const value = 1;\n');
		writeFileSync(oraclePath, 'create or replace package body demo is end demo;\n');
		const typescriptPlan = planOf('typescript', 'src', 'src/main.ts', '.ts');
		const oraclePlan = planOf('oracle', 'database', 'database/demo.pkb', '.pkb');
		const changes: ChangeType[] = [];
		let handoffs = 0;
		const controller = new AdapterWatchController({
			enabled: true,
			rootDir,
			logger: silentLogger,
			plans: [typescriptPlan],
			onChange: (paths, adapterIds): void => {
				changes.push({paths, adapterIds});
			},
			onHandoff: (): void => {
				handoffs += 1;
			},
		});

		try {
			controller.start();
			await vi.waitFor(() => {
				expect(handoffs).toBe(1);
			});
			controller.update([oraclePlan]);
			await vi.waitFor(() => {
				expect(handoffs).toBe(2);
			});
			expect(controller.plans).toStrictEqual([oraclePlan]);

			controller.update([oraclePlan]);
			await immediate();
			expect(handoffs).toBe(2);
			await delay(100);

			appendFileSync(typescriptPath, 'export const later = 2;\n');
			await delay(300);
			expect(changes).toStrictEqual([]);

			appendFileSync(oraclePath, '-- changed\n');
			await vi.waitFor(
				() => {
					expect(changes).toContainEqual({paths: ['database/demo.pkb'], adapterIds: ['oracle']});
				},
				{timeout: 3000, interval: 25},
			);

			controller.update([typescriptPlan]);
			controller.close();
			await immediate();
			expect(handoffs).toBe(2);
		} finally {
			controller.close();
			rmSync(rootDir, {recursive: true, force: true});
		}
	});
});
