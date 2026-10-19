import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {scanOracleProject} from '../src/adapters/oracle/scanProject.ts';
import {applyOracleLivePlan} from '../src/core/qualification/oracle/live/oracleDatabase.ts';
import {
	normalizeOracleSource,
	oracleObjectKeyOf,
	oracleSourceUnitsOf,
	type OracleInstalledSourceType,
} from '../src/core/qualification/oracle/live/oracleLiveSource.ts';
import {createOracleLivePlan, readOracleLivePlan, type LivePlanType} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {type SqlplusRequestType} from '../src/core/qualification/oracle/live/oracleRecompile.ts';
import {readOracleLiveSettings, type OracleLiveSettingsType} from '../src/core/qualification/oracle/live/oracleLiveSettings.ts';
import {runOracleLiveQualification} from '../src/core/qualification/oracle/live/runOracleLiveQualification.ts';
import {runCli} from '../src/transports/cli/runCli.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const fixture = (): ReturnType<typeof createFixtureConfig> => createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

const settingsOf = (outputDir: string, approval: string | null = null): OracleLiveSettingsType => ({
	outputDir,
	sqlplus: 'sqlplus',
	timeoutMs: 1000,
	approval,
	connection: approval === null ? null : {server: 'server', user: 'user', password: 'secret'},
});

const capture = (): Readonly<{stdout: string[]; stderr: string[]; io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>}> => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
	};
};

type StubDatabaseType = Readonly<{
	query: (sql: string) => Promise<readonly (readonly unknown[])[]>;
	close: () => Promise<void>;
}>;

const stubDatabase =
	(backup: readonly (readonly unknown[])[] = []): (() => Promise<StubDatabaseType>) =>
	async (): Promise<StubDatabaseType> => {
		await Promise.resolve();

		return {
			query: async (sql: string): Promise<readonly (readonly unknown[])[]> => {
				await Promise.resolve();
				return sql.includes('FROM user_source') ? backup : [];
			},
			close: async (): Promise<void> => {
				await Promise.resolve();
			},
		};
	};

const sourceRows = (plan: LivePlanType): readonly (readonly unknown[])[] =>
	plan.snapshot.units.flatMap((unit) =>
		normalizeOracleSource(readFileSync(path.join(plan.snapshot.dir, unit.path), 'utf8'), unit)
			.split('\n')
			.map((text, index) => [unit.type, unit.name, index + 1, text]),
	);

const installedSourcesOf = (config: Parameters<typeof scanOracleProject>[0]): ReadonlyMap<string, OracleInstalledSourceType> => {
	const installed = new Map<string, OracleInstalledSourceType>();

	for (const file of scanOracleProject(config).files) {
		for (const unit of oracleSourceUnitsOf(file.path, readFileSync(file.absolutePath, 'utf8'))) {
			installed.set(oracleObjectKeyOf(unit.object.type, unit.object.name), {
				type: unit.object.type,
				name: unit.object.name,
				source: unit.source,
			});
		}
	}

	return installed;
};

const qualificationConfig = (config: ReturnType<typeof fixture>['config'], manifestPath: string): ReturnType<typeof fixture>['config'] => ({
	...config,
	projectFilePath: manifestPath,
	projects: [{name: 'app', projectFilePath: manifestPath}],
});

const writeSelectionManifest = (manifestPath: string): void => {
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				dialect: '19c',
				defaultSchema: 'APP',
				extensions: ['.pks', '.pkb', '.sql'],
				include: ['database/**/*.pks', 'database/**/*.pkb', 'database/**/*.sql'],
				exclude: [],
			},
			null,
			2,
		)}\n`,
		{encoding: 'utf8'},
	);
};

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
			expect(readFileSync(plan.sql.identifiers.path, 'utf8')).toContain('user_identifiers');
			expect(readFileSync(plan.sql.dependencies.path, 'utf8')).toContain('user_dependencies');
			expect(readFileSync(path.join(outputDir, 'plan.json'), 'utf8')).not.toContain('secret');
			expect(plan.approval).toMatch(/^[a-f0-9]{64}$/u);
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

			const installed = new Map([
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

describe('Oracle live qualification application', () => {
	it('backs up, compiles, validates, and exports through the injected adapters', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan: LivePlanType = createOracleLivePlan(context.config, settingsOf(outputDir));
			const approved = settingsOf(outputDir, plan.approval);
			const requests: SqlplusRequestType[] = [];
			const events: string[] = [];

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
								if (sql.includes("status = 'INVALID'")) {
									events.push('validate');
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

			expect(events).toStrictEqual(['backup', 'compile', 'validate', 'identifiers', 'dependencies', 'close']);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.input).toContain('connect "user"/"secret"@server');
			expect(readFileSync(plan.output.backup, 'utf8')).toContain('HR_API');
			expect(readFileSync(plan.output.identifiers, 'utf8')).toContain('RUN');
			expect(readFileSync(plan.output.invalidObjects, 'utf8')).toBe('');
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
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
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
						databaseFactory: stubDatabase(altered),
					},
				),
			).rejects.toThrow(/differs from the snapshot/u);

			expect(recompiled).toBe(false);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification run', () => {
	it('applies an approved plan from the frozen snapshot', async () => {
		const context = fixture();
		const captured = capture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const code = await runOracleLiveQualification(
				{ORACLE_SERVER: 'server', ORACLE_USER: 'user', ORACLE_PASSWORD: 'secret'},
				{root: context.config.rootDir, output: outputDir, approval: plan.approval},
				captured.io,
				{
					sqlplusRunner: () => ({status: 0, stdout: '', stderr: ''}),
					databaseFactory: stubDatabase(sourceRows(plan)),
				},
			);

			expect(captured.stderr).toStrictEqual([]);
			expect(existsSync(plan.output.run)).toBe(true);
			expect([0, 1]).toContain(code);
		} finally {
			context.cleanup();
		}
	});

	it('requires output outside the indexed workspace', () => {
		const context = fixture();

		try {
			expect(() => readOracleLiveSettings({}, {rootDir: context.config.rootDir, outputDir: path.join(context.config.rootDir, 'results')})).toThrow(
				/outside the indexed workspace/u,
			);
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification command', () => {
	it('creates a plan from only a source root', async () => {
		const context = fixture();
		const captured = capture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const code = await runCli(['qualify-oracle-live', '--root', context.config.rootDir, '--schema', 'HR', '--output', outputDir], {}, captured.io);

			expect(captured.stderr).toStrictEqual([]);
			expect(code).toBe(0);
			expect(captured.stdout.join('\n')).toContain('WARNING: ORACLE DATABASE CHANGES');
			expect(captured.stdout.join('\n')).toContain('No database connection has been made');
			expect(captured.stdout.join('\n')).toContain('Approval:');

			const plan = readFileSync(path.join(outputDir, 'plan.json'), 'utf8');
			expect(plan).toContain('"path": "manifests/0-oracle-index.json"');
			expect(existsSync(path.join(outputDir, 'workspace', 'manifests', '0-oracle-index.json'))).toBe(true);
		} finally {
			context.cleanup();
		}
	});

	it('requires a source root argument', async () => {
		const captured = capture();
		const code = await runCli(['qualify-oracle-live'], {}, captured.io);

		expect(code).toBe(2);
		expect(captured.stderr.join('\n')).toContain('requires --root');
	});
});
