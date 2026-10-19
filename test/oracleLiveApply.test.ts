import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {applyOracleLivePlan} from '../src/core/qualification/oracle/live/oracleDatabase.ts';
import {createOracleLivePlan, type LivePlanType} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {type SqlplusRequestType} from '../src/core/qualification/oracle/live/oracleRecompile.ts';
import {fixture, installedSourcesOf, inventoryDatabase, settingsOf, sourceRows} from './helpers/oracleLive.ts';

describe('Oracle live qualification application', () => {
	it('backs up, compiles, validates, and exports through the injected adapters', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan: LivePlanType = createOracleLivePlan(context.config, settingsOf(outputDir));
			const approved = settingsOf(outputDir, plan.approval);
			const requests: SqlplusRequestType[] = [];
			const events: string[] = [];
			let invalidQueries = 0;

			await applyOracleLivePlan(
				plan,
				approved,
				{},
				{
					sqlplusRunner: (request) => {
						events.push('compile');
						requests.push(request);
						return {status: 0, stdout: '', stderr: ''};
					},
					databaseFactory: async (): Promise<{query: (sql: string) => Promise<readonly (readonly unknown[])[]>; close: () => Promise<void>}> => {
						await Promise.resolve();
						return {
							query: async (sql: string): Promise<readonly (readonly unknown[])[]> => {
								await Promise.resolve();
								if (sql.includes('FROM user_source')) {
									events.push('backup');
									return sourceRows(plan);
								}
								if (sql.includes("status <> 'VALID'")) {
									invalidQueries += 1;
									events.push(invalidQueries === 1 ? 'baseline' : 'validate');
									return [];
								}
								if (sql.includes('FROM user_identifiers')) {
									events.push('identifiers');
									return [['HR_API', 'PACKAGE', 'RUN', '', 'PROCEDURE', 'DECLARATION', 1, 1, 9, 1]];
								}
								if (sql.includes('FROM user_dependencies')) {
									events.push('dependencies');
									return [];
								}
								throw new Error(`Unexpected SQL: ${sql}`);
							},
							close: async (): Promise<void> => {
								await Promise.resolve();
								events.push('close');
							},
						};
					},
				},
			);

			expect(events).toStrictEqual(['baseline', 'backup', 'compile', 'validate', 'identifiers', 'dependencies', 'close']);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.input).toContain('connect "user"/"secret"@server');
			expect(readFileSync(plan.output.backup, 'utf8')).toContain('HR_API');
			expect(readFileSync(plan.output.identifiers, 'utf8')).toContain('RUN');
			expect(readFileSync(plan.output.baselineInvalidObjects, 'utf8')).toBe('');
			expect(readFileSync(plan.output.invalidObjects, 'utf8')).toBe('');
		} finally {
			context.cleanup();
		}
	});

	it('recompiles dependents after all qualification targets', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const dependencies = [{name: 'HR_VIEW', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'}];
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installedSourcesOf(context.config), dependencies);
			const requests: SqlplusRequestType[] = [];

			await applyOracleLivePlan(
				plan,
				settingsOf(outputDir, plan.approval),
				{},
				{
					sqlplusRunner: (request) => {
						requests.push(request);
						return {status: 0, stdout: '', stderr: ''};
					},
					databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline: [], invalid: []}),
				},
			);

			expect(requests).toHaveLength(2);
			expect(requests[0]?.input).toContain(plan.sql.compile.path);
			expect(requests[1]?.input).toContain(plan.sql.dependents.path);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification invalid-object comparison', () => {
	it('reports baseline-invalid objects without failing or attributing them to qualification', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const baseline = [['VIEW', 'LEGACY_VIEW', 'INVALID']];
			const result = await applyOracleLivePlan(
				plan,
				settingsOf(outputDir, plan.approval),
				{},
				{
					sqlplusRunner: () => ({status: 0, stdout: '', stderr: ''}),
					databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline, invalid: baseline}),
				},
			);

			expect(result.baselineInvalid).toHaveLength(1);
			expect(result.remainingBaselineInvalid).toHaveLength(1);
			expect(result.restoredBaselineInvalid).toStrictEqual([]);
			expect(readFileSync(plan.output.baselineInvalidObjects, 'utf8')).toContain('LEGACY_VIEW');
			expect(readFileSync(plan.output.invalidObjects, 'utf8')).toContain('LEGACY_VIEW');
		} finally {
			context.cleanup();
		}
	});

	it('fails when an approved dependent is still invalid after restoration', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const dependencies = [{name: 'HR_VIEW', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'}];
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installedSourcesOf(context.config), dependencies);
			const baseline = [['VIEW', 'HR_VIEW', 'INVALID']];

			await expect(
				applyOracleLivePlan(
					plan,
					settingsOf(outputDir, plan.approval),
					{},
					{
						sqlplusRunner: () => ({status: 0, stdout: '', stderr: ''}),
						databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline, invalid: baseline}),
					},
				),
			).rejects.toThrow(/failed to restore dependent objects: VIEW HR_VIEW INVALID/u);
		} finally {
			context.cleanup();
		}
	});

	it('fails when a new invalid object appears compared with the baseline', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));

			await expect(
				applyOracleLivePlan(
					plan,
					settingsOf(outputDir, plan.approval),
					{},
					{
						sqlplusRunner: () => ({status: 0, stdout: '', stderr: ''}),
						databaseFactory: inventoryDatabase({
							backup: sourceRows(plan),
							baseline: [],
							invalid: [['VIEW', 'NEW_VIEW', 'INVALID']],
						}),
					},
				),
			).rejects.toThrow(/new invalid objects: VIEW NEW_VIEW INVALID/u);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification progress and target validation', () => {
	it('reports phase and per-object progress', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const progress: string[] = [];
			const total = plan.snapshot.units.length;

			await applyOracleLivePlan(
				plan,
				settingsOf(outputDir, plan.approval),
				{},
				{
					sqlplusRunner: (request) => {
						for (const unit of plan.snapshot.units) {
							request.onOutput?.(`RECOMPILE:${unit.type}:${unit.name}`);
						}

						return {status: 0, stdout: '', stderr: ''};
					},
					databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline: [], invalid: []}),
					progress: (line) => {
						progress.push(line);
					},
				},
			);

			expect(progress).toContain('Capturing pre-DDL invalid-object baseline...');
			expect(progress).toContain(`Recompiling ${String(total)} target objects...`);
			expect(progress.some((line) => line.startsWith(`Targets: ${String(total)}/${String(total)} `))).toBe(true);
			expect(progress).toContain('Validating target PL/SQL and dependent restoration...');
			expect(progress.some((line) => line.startsWith('Database work completed in '))).toBe(true);
		} finally {
			context.cleanup();
		}
	});

	it('fails when a qualification target remains invalid', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const invalidTarget = [['PACKAGE', 'HR_API', 'INVALID']];

			await expect(
				applyOracleLivePlan(
					plan,
					settingsOf(outputDir, plan.approval),
					{},
					{
						sqlplusRunner: () => ({status: 0, stdout: '', stderr: ''}),
						databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline: invalidTarget, invalid: invalidTarget}),
					},
				),
			).rejects.toThrow(/invalid target PL\/SQL: PACKAGE HR_API INVALID/u);
		} finally {
			context.cleanup();
		}
	});
});
