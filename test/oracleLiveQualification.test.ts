import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {applyOracleLivePlan} from '../src/core/qualification/oracle/live/oracleDatabase.ts';
import {normalizeOracleSource, oracleObjectKeyOf, oracleSourceObjectOf} from '../src/core/qualification/oracle/live/oracleLiveSource.ts';
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
	plan.snapshot.files.flatMap((file) => {
		const object = oracleSourceObjectOf(file.path);

		if (object === null) {
			return [];
		}

		return normalizeOracleSource(readFileSync(path.join(plan.snapshot.dir, file.path), 'utf8'))
			.split('\n')
			.map((text, index) => [object.type, object.name, index + 1, text]);
	});

describe('Oracle live qualification plan', () => {
	it('creates a frozen snapshot, ordered SQL, and an approval hash without credentials', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const compile = readFileSync(plan.sql.compile.path, 'utf8');

			expect(plan.snapshot.files.length).toBeGreaterThan(5);
			expect(existsSync(path.join(plan.snapshot.dir, 'oracle-index.json'))).toBe(true);
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
			const installed = new Set([oracleObjectKeyOf('PACKAGE', 'HR_API'), oracleObjectKeyOf('PACKAGE BODY', 'HR_API')]);
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installed);
			const compile = readFileSync(plan.sql.compile.path, 'utf8');

			expect(plan.snapshot.files.map((file) => file.path)).toStrictEqual(['database/hr_api.pkb', 'database/hr_api.pks']);
			expect(compile).toContain('ALTER PACKAGE "HR_API" COMPILE SPECIFICATION;');
			expect(compile).toContain('ALTER PACKAGE "HR_API" COMPILE BODY;');
			expect(compile).not.toContain('SALES_API');
		} finally {
			context.cleanup();
		}
	});

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
			const altered = sourceRows(plan).map((row, index) => (index === 0 ? [row[0], row[1], row[2], `${String(row[3])} -- drift`] : row));
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
