import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {applyOracleLivePlan} from '../src/core/qualification/oracle/live/oracleDatabase.ts';
import {normalizeOracleSource, oracleObjectKeyOf, type OracleInstalledSourceType} from '../src/core/qualification/oracle/live/oracleLiveSource.ts';
import {createOracleLivePlan, readOracleLivePlan, type LivePlanType} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {fixture, installedSourcesOf, qualificationConfig, settingsOf, sourceRows, writeSelectionManifest} from './helpers/oracleLive.ts';

describe('Oracle live qualification plan', () => {
	it('creates a frozen snapshot, ordered SQL, and an approval hash without credentials', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const compile = readFileSync(plan.sql.compile.path, 'utf8');

			expect(plan.snapshot.files.length).toBeGreaterThan(5);
			expect(existsSync(path.join(plan.snapshot.dir, 'manifests', 'qualification-index.json'))).toBe(true);
			expect(compile).toContain('ALTER PACKAGE "HR_API" COMPILE SPECIFICATION;');
			expect(compile).toContain('ALTER PACKAGE "HR_API" COMPILE BODY;');
			expect(compile.indexOf('COMPILE SPECIFICATION')).toBeLessThan(compile.indexOf('COMPILE BODY'));
			expect(compile).not.toContain('@"');
			expect(compile).toContain("ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL';");
			expect(readFileSync(plan.sql.baseline.path, 'utf8')).toContain("status <> 'VALID'");
			expect(readFileSync(plan.sql.dependents.path, 'utf8')).toContain('WHENEVER SQLERROR CONTINUE');
			expect(readFileSync(plan.sql.identifiers.path, 'utf8')).toContain('user_identifiers');
			expect(readFileSync(plan.sql.dependencies.path, 'utf8')).toContain('user_dependencies');
			expect(readFileSync(path.join(outputDir, 'plan.json'), 'utf8')).not.toContain('secret');
			expect(plan.snapshot.dependenciesChecked).toBe(false);
			expect(plan.snapshot.dependents).toStrictEqual([]);
			expect(plan.approval).toMatch(/^[a-f0-9]{64}$/u);
		} finally {
			context.cleanup();
		}
	});

	it('binds transitive dependent recompilation in dependency order', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const dependencies = [
				{name: 'HR_VIEW', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'},
				{name: 'HR_VIEW_CHILD', type: 'VIEW', referencedName: 'HR_VIEW', referencedType: 'VIEW'},
				{name: 'HR_TRIGGER', type: 'TRIGGER', referencedName: 'HR_API', referencedType: 'PACKAGE'},
				{name: 'HR_VIEW_ON_SALES', type: 'VIEW', referencedName: 'SALES_API', referencedType: 'PACKAGE'},
				{name: 'HR_TABLE', type: 'TABLE', referencedName: 'HR_API', referencedType: 'PACKAGE'},
			];
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installedSourcesOf(context.config), dependencies);
			const dependentSql = readFileSync(plan.sql.dependents.path, 'utf8');

			expect(plan.snapshot.dependenciesChecked).toBe(true);
			expect(plan.snapshot.dependents.map((dependent) => dependent.name)).toStrictEqual(['HR_TRIGGER', 'HR_VIEW', 'HR_VIEW_ON_SALES', 'HR_VIEW_CHILD']);
			expect(plan.snapshot.dependents.map((dependent) => dependent.depth)).toStrictEqual([1, 1, 1, 2]);
			expect(dependentSql).toContain('ALTER TRIGGER "HR_TRIGGER" COMPILE;');
			expect(dependentSql).toContain('ALTER VIEW "HR_VIEW" COMPILE;');
			expect(dependentSql).toContain('ALTER VIEW "HR_VIEW_CHILD" COMPILE;');
			expect(dependentSql).not.toContain('HR_TABLE');
			expect(dependentSql.indexOf('"HR_VIEW"')).toBeLessThan(dependentSql.indexOf('"HR_VIEW_CHILD"'));
		} finally {
			context.cleanup();
		}
	});

	it('keeps only source files for installed objects', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const installed = new Map(
				[...installedSourcesOf(context.config)].filter(([key]) =>
					[oracleObjectKeyOf('PACKAGE', 'HR_API'), oracleObjectKeyOf('PACKAGE BODY', 'HR_API')].includes(key),
				),
			);
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installed);
			const compile = readFileSync(plan.sql.compile.path, 'utf8');

			expect(plan.snapshot.files.map((file) => file.path)).toStrictEqual(['database/hr_api.pkb', 'database/hr_api.pks']);
			expect(plan.snapshot.units.map((unit) => unit.name)).toStrictEqual(['HR_API', 'HR_API']);
			expect(compile).toContain('ALTER PACKAGE "HR_API" COMPILE SPECIFICATION;');
			expect(compile).toContain('ALTER PACKAGE "HR_API" COMPILE BODY;');
			expect(compile).not.toContain('SALES_API');
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification source selection', () => {
	it('selects the candidate that matches installed source instead of a legacy filename', () => {
		const context = fixture();

		try {
			const manifestPath = path.join(context.config.rootDir, 'qualification-index.json');
			const legacyPath = path.join(context.config.rootDir, 'database', 'legacy_api.pks');
			const deployedPath = path.join(context.config.rootDir, 'database', 'deployment', 'legacy_api.sql');
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const config = qualificationConfig(context.config, manifestPath);

			writeFileSync(legacyPath, 'CREATE OR REPLACE PACKAGE LEGACY_API AS\nPROCEDURE old_thing;\nEND LEGACY_API;\n/\n', {encoding: 'utf8'});
			mkdirSync(path.dirname(deployedPath), {recursive: true});
			writeFileSync(deployedPath, 'set define off\n\nCREATE OR REPLACE\nPACKAGE LEGACY_API IS\nPROCEDURE new_thing;\nEND LEGACY_API;\n/\nset define on\n', {
				encoding: 'utf8',
			});
			writeSelectionManifest(manifestPath);

			const installed = new Map([
				[
					oracleObjectKeyOf('PACKAGE', 'LEGACY_API'),
					{type: 'PACKAGE', name: 'LEGACY_API', source: 'PACKAGE LEGACY_API IS\nPROCEDURE new_thing;\nEND LEGACY_API;'},
				],
			]);
			const plan = createOracleLivePlan(config, settingsOf(outputDir), installed);
			const snapshot = readFileSync(path.join(plan.snapshot.dir, plan.snapshot.units[0]?.path ?? ''), 'utf8');

			expect(plan.snapshot.units).toHaveLength(1);
			expect(plan.snapshot.units[0]?.sourcePath).toBe('database/deployment/legacy_api.sql');
			expect(plan.snapshot.units[0]?.candidatePaths).toStrictEqual(['database/deployment/legacy_api.sql']);
			expect(snapshot).toContain('new_thing');
			expect(snapshot).not.toContain('old_thing');
		} finally {
			context.cleanup();
		}
	});

	it('writes only the selected unit from a multi-unit SQL file', () => {
		const context = fixture();

		try {
			const manifestPath = path.join(context.config.rootDir, 'qualification-index.json');
			const combinedPath = path.join(context.config.rootDir, 'database', 'combined.sql');
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const config = qualificationConfig(context.config, manifestPath);

			writeFileSync(
				combinedPath,
				'CREATE OR REPLACE PACKAGE KEPT_API IS\nPROCEDURE kept;\nEND KEPT_API;\n/\nCREATE OR REPLACE PACKAGE DROPPED_API IS\nPROCEDURE dropped;\nEND DROPPED_API;\n/\n',
				{encoding: 'utf8'},
			);
			writeSelectionManifest(manifestPath);

			const installed = new Map([
				[oracleObjectKeyOf('PACKAGE', 'KEPT_API'), {type: 'PACKAGE', name: 'KEPT_API', source: 'PACKAGE KEPT_API IS\nPROCEDURE kept;\nEND KEPT_API;'}],
				[
					oracleObjectKeyOf('PACKAGE', 'DROPPED_API'),
					{type: 'PACKAGE', name: 'DROPPED_API', source: 'PACKAGE DROPPED_API IS\nPROCEDURE dropped;\nEND DROPPED_API;'},
				],
			]);
			const plan = createOracleLivePlan(config, settingsOf(outputDir), installed);
			const kept = plan.snapshot.units.find((unit) => unit.name === 'KEPT_API');
			const dropped = plan.snapshot.units.find((unit) => unit.name === 'DROPPED_API');

			expect(kept?.path).toMatch(/^units\/\d+-KEPT_API\.pks$/u);
			expect(dropped?.path).toMatch(/^units\/\d+-DROPPED_API\.pks$/u);
			expect(readFileSync(path.join(plan.snapshot.dir, kept?.path ?? ''), 'utf8')).not.toContain('DROPPED_API');
			expect(readFileSync(path.join(plan.snapshot.dir, dropped?.path ?? ''), 'utf8')).not.toContain('KEPT_API');
			expect(plan.snapshot.files).toHaveLength(2);
		} finally {
			context.cleanup();
		}
	});

	it('fails before writing an approval when no candidate matches installed source', () => {
		const context = fixture();

		try {
			const manifestPath = path.join(context.config.rootDir, 'qualification-index.json');
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const config = qualificationConfig(context.config, manifestPath);

			writeSelectionManifest(manifestPath);
			mkdirSync(outputDir, {recursive: true});

			const installed: ReadonlyMap<string, OracleInstalledSourceType> = new Map([
				[oracleObjectKeyOf('PACKAGE', 'HR_API'), {type: 'PACKAGE', name: 'HR_API', source: 'PACKAGE HR_API IS\nPROCEDURE missing_from_source;\nEND HR_API;'}],
			]);

			expect(() => createOracleLivePlan(config, settingsOf(outputDir), installed)).toThrow(/database\/hr_api\.pks sha256=[a-f0-9]{64}/u);
			expect(existsSync(path.join(outputDir, 'plan.json'))).toBe(false);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification approval', () => {
	it('requires the exact approval and detects modified SQL', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const approved = settingsOf(outputDir, plan.approval);

			expect(readOracleLivePlan(approved).approval).toBe(plan.approval);
			expect(() => readOracleLivePlan({...approved, approval: '0'.repeat(64)})).toThrow(/approval hash/u);

			writeFileSync(plan.sql.backup.path, '-- modified\n', {encoding: 'utf8'});
			expect(() => readOracleLivePlan(approved)).toThrow(/SQL changed/u);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification drift', () => {
	it('ignores file comments, keyword case, and AS/IS spelling during normalization', () => {
		const authored = '/*** header ***/\n-- note\nCREATE OR REPLACE\nPackage X as\nPROCEDURE P;\nEND X;\n/\n';
		const installed = 'PACKAGE X IS\nPROCEDURE P;\nEND X;';
		const object = {type: 'PACKAGE', name: 'X', compileClause: 'SPECIFICATION'} as const;

		expect(normalizeOracleSource(authored, object)).toBe(normalizeOracleSource(installed, object));
	});

	it('selects the matching unit from a multi-unit source file', () => {
		const authored = 'CREATE OR REPLACE TYPE T AS OBJECT (id NUMBER);\n/\nCREATE OR REPLACE\nPACKAGE BODY X AS\nPROCEDURE P IS BEGIN NULL; END;\nEND X;\n/\n';
		const installed = 'PACKAGE BODY X IS\nPROCEDURE P IS BEGIN NULL; END;\nEND X;';
		const object = {type: 'PACKAGE BODY', name: 'X', compileClause: 'BODY'} as const;

		expect(normalizeOracleSource(authored, object)).toBe(normalizeOracleSource(installed, object));
	});

	it('aborts before recompilation when installed source drifted', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan: LivePlanType = createOracleLivePlan(context.config, settingsOf(outputDir));
			const approved = settingsOf(outputDir, plan.approval);
			const altered = sourceRows(plan).map((row, index) => (index === 0 ? [row[0], row[1], row[2], String(row[3]).replace('hr_api', 'hr_apx')] : row));
			let recompiled = false;

			await expect(
				applyOracleLivePlan(
					plan,
					approved,
					{},
					{
						sqlplusRunner: () => {
							recompiled = true;
							return {status: 0, stdout: '', stderr: ''};
						},
						databaseFactory: async (): Promise<{query: (sql: string) => Promise<readonly (readonly unknown[])[]>; close: () => Promise<void>}> => {
							await Promise.resolve();

							return {
								query: async (sql: string): Promise<readonly (readonly unknown[])[]> => {
									await Promise.resolve();
									return sql.includes('FROM user_source') ? altered : [];
								},
								close: async (): Promise<void> => {
									await Promise.resolve();
								},
							};
						},
					},
				),
			).rejects.toThrow(/differs from the snapshot/u);

			expect(recompiled).toBe(false);
		} finally {
			context.cleanup();
		}
	});
});
