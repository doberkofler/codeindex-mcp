import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createOracleLivePlan} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {recompileOracleDependents, recompileOracleObjects} from '../src/core/qualification/oracle/live/oracleRecompile.ts';
import {fixture, installedSourcesOf, settingsOf} from './helpers/oracleLive.ts';

const executorOf = (execute: (sql: string) => Promise<void>): Readonly<{execute: (sql: string) => Promise<void>}> => ({execute});

describe('Oracle recompilation', () => {
	it('recompiles targets with PL/Scope and reports counted progress without object names', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const executed: string[] = [];
			const progress: string[] = [];
			const total = plan.snapshot.units.length;

			await recompileOracleObjects(
				plan,
				executorOf(async (sql) => {
					executed.push(sql);
					await Promise.resolve();
				}),
				{
					progress: (line) => {
						progress.push(line);
					},
				},
			);

			expect(executed[0]).toBe("ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL'");
			expect(executed).toHaveLength(total + 1);
			expect(progress).toContain(`Recompiling ${String(total)} target objects...`);
			expect(progress.some((line) => line.startsWith(`Targets: 1/${String(total)}, ETA ~`))).toBe(true);
			expect(progress).toContain(`Targets: ${String(total)}/${String(total)} complete in 0s`);
			expect(progress.some((line) => line.includes('HR_API'))).toBe(false);
			expect(readFileSync(plan.output.compileLog, 'utf8')).toContain('ALTER PACKAGE "HR_API" COMPILE SPECIFICATION;');
		} finally {
			context.cleanup();
		}
	});

	it('recompiles dependents with a dependent progress label', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const dependencies = [{name: 'HR_VIEW', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'}];
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installedSourcesOf(context.config), dependencies);
			const executed: string[] = [];
			const progress: string[] = [];

			await recompileOracleDependents(
				plan,
				executorOf(async (sql) => {
					executed.push(sql);
					await Promise.resolve();
				}),
				{
					progress: (line) => {
						progress.push(line);
					},
				},
			);

			expect(executed).toStrictEqual(['ALTER VIEW "HR_VIEW" COMPILE']);
			expect(progress).toContain('Recompiling 1 dependent objects...');
			expect(progress).toContain('Dependents: 1/1 complete in 0s');
			expect(progress.some((line) => line.includes('HR_VIEW'))).toBe(false);
			expect(readFileSync(plan.output.dependentCompileLog, 'utf8')).toContain('ALTER VIEW "HR_VIEW" COMPILE;');
		} finally {
			context.cleanup();
		}
	});

	it('does not execute anything when a plan has no dependents', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			let executed = false;

			await recompileOracleDependents(
				plan,
				executorOf(async () => {
					executed = true;
					await Promise.resolve();
				}),
			);

			expect(executed).toBe(false);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle recompilation failures', () => {
	it('reports the driver error when target recompilation fails', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));

			await expect(
				recompileOracleObjects(
					plan,
					executorOf(async () => {
						await Promise.resolve();
						throw new Error('ORA-04063: view has errors');
					}),
				),
			).rejects.toThrow(/Oracle recompile step failed[\s\S]*ORA-04063/u);
		} finally {
			context.cleanup();
		}
	});

	it('continues after a dependent error and records it in the log', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const dependencies = [
				{name: 'HR_VIEW', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'},
				{name: 'HR_VIEW_CHILD', type: 'VIEW', referencedName: 'HR_VIEW', referencedType: 'VIEW'},
			];
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installedSourcesOf(context.config), dependencies);
			const executed: string[] = [];

			await recompileOracleDependents(
				plan,
				executorOf(async (sql) => {
					executed.push(sql);
					await Promise.resolve();

					if (sql.includes('"HR_VIEW"')) {
						throw new Error('ORA-04063: view has errors');
					}
				}),
			);

			expect(executed).toHaveLength(2);
			expect(readFileSync(plan.output.dependentCompileLog, 'utf8')).toContain('-- ERROR: ORA-04063: view has errors');
		} finally {
			context.cleanup();
		}
	});
});
