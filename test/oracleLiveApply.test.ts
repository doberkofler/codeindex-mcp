import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {applyOracleLivePlan} from '../src/core/qualification/oracle/live/oracleDatabase.ts';
import {createOracleLivePlan, type LivePlanType} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {fixture, installedSourcesOf, inventoryDatabase, settingsOf, sourceRows, type StubDatabaseType} from './helpers/oracleLive.ts';

type InvalidationEdgeType = Readonly<{name: string; referencedName: string}>;

const recompileWithInvalidation = (sql: string, edges: readonly InvalidationEdgeType[], invalid: Set<string>, executed: string[]): void => {
	executed.push(sql);
	const openingQuote = sql.indexOf('"');
	const closingQuote = sql.indexOf('"', openingQuote + 1);
	const name = openingQuote === -1 || closingQuote === -1 ? undefined : sql.slice(openingQuote + 1, closingQuote);

	if (name === undefined) {
		return;
	}

	for (const edge of edges) {
		if (edge.referencedName === name) {
			invalid.add(edge.name);
		}
	}

	invalid.delete(name);
};

/**
 * Creates a database stub where recompiling an object invalidates its dependents.
 *
 * @param plan - Approved plan whose backup must match the frozen snapshot.
 * @param edges - Referenced-object to dependent edges.
 * @param invalid - Mutable simulated invalid-object set.
 * @param executed - Mutable list of executed statements.
 * @returns A database factory for the apply workflow.
 */
const invalidatingDatabase =
	(plan: LivePlanType, edges: readonly InvalidationEdgeType[], invalid: Set<string>, executed: string[]): (() => Promise<StubDatabaseType>) =>
	async (): Promise<StubDatabaseType> => {
		await Promise.resolve();
		let invalidQueries = 0;

		return {
			query: async (sql: string): Promise<readonly (readonly unknown[])[]> => {
				await Promise.resolve();

				if (sql.includes('FROM user_source')) {
					return sourceRows(plan);
				}

				if (sql.includes("status <> 'VALID'")) {
					invalidQueries += 1;

					return invalidQueries === 1 ? [] : [...invalid].map((name) => ['VIEW', name, 'INVALID']);
				}

				if (sql.includes('FROM user_identifiers') || sql.includes('FROM user_dependencies')) {
					return [];
				}

				throw new Error(`Unexpected SQL: ${sql}`);
			},
			execute: async (sql: string): Promise<void> => {
				await Promise.resolve();
				recompileWithInvalidation(sql, edges, invalid, executed);
			},
			close: async (): Promise<void> => {
				await Promise.resolve();
			},
		};
	};

describe('Oracle live qualification application', () => {
	it('backs up, compiles, validates, and exports through one injected session', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan: LivePlanType = createOracleLivePlan(context.config, settingsOf(outputDir));
			const approved = settingsOf(outputDir, plan.approval);
			const executed: string[] = [];
			const events: string[] = [];
			let invalidQueries = 0;

			await applyOracleLivePlan(plan, approved, {
				databaseFactory: async (
					_connection,
					timeoutMs,
				): Promise<{
					query: (sql: string) => Promise<readonly (readonly unknown[])[]>;
					execute: (sql: string) => Promise<void>;
					close: () => Promise<void>;
				}> => {
					await Promise.resolve();
					expect(timeoutMs).toBe(1000);

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
						execute: async (sql: string): Promise<void> => {
							await Promise.resolve();
							executed.push(sql);

							if (!events.includes('compile')) {
								events.push('compile');
							}
						},
						close: async (): Promise<void> => {
							await Promise.resolve();
							events.push('close');
						},
					};
				},
			});

			expect(events).toStrictEqual(['baseline', 'backup', 'compile', 'validate', 'identifiers', 'dependencies', 'close']);
			expect(executed).toHaveLength(plan.snapshot.units.length + 1);
			expect(executed[0]).toBe("ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL'");
			expect(executed).toContain('ALTER PACKAGE "HR_API" COMPILE SPECIFICATION');
			expect(readFileSync(plan.output.backup, 'utf8')).toContain('HR_API');
			expect(readFileSync(plan.output.identifiers, 'utf8')).toContain('RUN');
			expect(readFileSync(plan.output.baselineInvalidObjects, 'utf8')).toBe('');
			expect(readFileSync(plan.output.invalidObjects, 'utf8')).toBe('');
			expect(readFileSync(plan.output.compileLog, 'utf8')).toContain('ALTER PACKAGE "HR_API" COMPILE SPECIFICATION;');
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification dependent restoration', () => {
	it('restores a shared dependent after every object that invalidates it', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const dependencies = [
				{name: 'HR_ZETA', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'},
				{name: 'HR_ALPHA', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'},
				{name: 'HR_ALPHA', type: 'VIEW', referencedName: 'HR_ZETA', referencedType: 'VIEW'},
			];
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installedSourcesOf(context.config), dependencies);
			const invalid = new Set<string>();
			const executed: string[] = [];

			await applyOracleLivePlan(plan, settingsOf(outputDir, plan.approval), {
				databaseFactory: invalidatingDatabase(plan, dependencies, invalid, executed),
			});

			const zeta = executed.findIndex((sql) => sql.includes('"HR_ZETA"'));
			const alpha = executed.findIndex((sql) => sql.includes('"HR_ALPHA"'));

			expect(zeta).toBeGreaterThan(0);
			expect(alpha).toBeGreaterThan(zeta);
			expect(invalid.size).toBe(0);
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
			const executed: string[] = [];

			await applyOracleLivePlan(plan, settingsOf(outputDir, plan.approval), {
				databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline: [], invalid: []}, (sql) => {
					executed.push(sql);
				}),
			});

			expect(executed).toHaveLength(plan.snapshot.units.length + 2);
			expect(executed.slice(0, plan.snapshot.units.length + 1).every((sql) => !sql.includes('HR_VIEW'))).toBe(true);
			expect(executed.at(-1)).toBe('ALTER VIEW "HR_VIEW" COMPILE');
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
			const result = await applyOracleLivePlan(plan, settingsOf(outputDir, plan.approval), {
				databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline, invalid: baseline}),
			});

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
				applyOracleLivePlan(plan, settingsOf(outputDir, plan.approval), {
					databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline, invalid: baseline}),
				}),
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
				applyOracleLivePlan(plan, settingsOf(outputDir, plan.approval), {
					databaseFactory: inventoryDatabase({
						backup: sourceRows(plan),
						baseline: [],
						invalid: [['VIEW', 'NEW_VIEW', 'INVALID']],
					}),
				}),
			).rejects.toThrow(/new invalid objects: VIEW NEW_VIEW INVALID/u);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification progress and target validation', () => {
	it('reports phase and counted progress', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const progress: string[] = [];
			const total = plan.snapshot.units.length;

			await applyOracleLivePlan(plan, settingsOf(outputDir, plan.approval), {
				databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline: [], invalid: []}),
				progress: (line) => {
					progress.push(line);
				},
			});

			expect(progress).toContain('Capturing pre-DDL invalid-object baseline...');
			expect(progress).toContain(`Recompiling ${String(total)} target objects...`);
			expect(progress).toContain(`Targets: ${String(total)}/${String(total)} complete in 0s`);
			expect(progress.some((line) => line.startsWith('Source verified ('))).toBe(true);
			expect(progress).toContain('Validating target PL/SQL and dependent restoration...');
			expect(progress.some((line) => line.startsWith('Validation passed ('))).toBe(true);
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
				applyOracleLivePlan(plan, settingsOf(outputDir, plan.approval), {
					databaseFactory: inventoryDatabase({backup: sourceRows(plan), baseline: invalidTarget, invalid: invalidTarget}),
				}),
			).rejects.toThrow(/invalid target PL\/SQL: PACKAGE HR_API INVALID/u);
		} finally {
			context.cleanup();
		}
	});
});
