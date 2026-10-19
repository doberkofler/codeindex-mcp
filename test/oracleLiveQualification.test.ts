import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {applyOracleLivePlan} from '../src/core/qualification/oracle/live/oracleDatabase.ts';
import {type SqlplusRequestType} from '../src/core/qualification/oracle/live/oracleCompile.ts';
import {createOracleLivePlan, readOracleLivePlan, type LivePlanType} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {readOracleLiveSettings, type OracleLiveSettingsType} from '../src/core/qualification/oracle/live/oracleLiveSettings.ts';
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

describe('Oracle live qualification plan', () => {
	it('creates a frozen snapshot, ordered SQL, and an approval hash without credentials', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const compile = readFileSync(plan.sql.compile.path, 'utf8');

			expect(plan.snapshot.files.length).toBeGreaterThan(5);
			expect(existsSync(path.join(plan.snapshot.dir, 'oracle-index.json'))).toBe(true);
			expect(compile.indexOf('hr_api.pks')).toBeLessThan(compile.indexOf('hr_api.pkb'));
			expect(compile).toContain("ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL';");
			expect(readFileSync(plan.sql.identifiers.path, 'utf8')).toContain('user_identifiers');
			expect(readFileSync(plan.sql.dependencies.path, 'utf8')).toContain('user_dependencies');
			expect(readFileSync(path.join(outputDir, 'plan.json'), 'utf8')).not.toContain('secret');
			expect(plan.approval).toMatch(/^[a-f0-9]{64}$/u);
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
					databaseFactory: async (): Promise<{query: (sql: string) => Promise<readonly unknown[][]>; close: () => Promise<void>}> => {
						await Promise.resolve();
						return {
							query: async (sql: string): Promise<readonly unknown[][]> => {
								await Promise.resolve();
								if (sql.includes('FROM user_source')) {
									events.push('backup');
									return [['PACKAGE', 'HR_API', 1, 'x']];
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

	it('requires output outside the indexed workspace', () => {
		const context = fixture();

		try {
			expect(() => readOracleLiveSettings({CODE_INDEX_QUALIFICATION_OUTPUT_DIR: path.join(context.config.rootDir, 'results')}, context.config)).toThrow(
				/outside the indexed workspace/u,
			);
		} finally {
			context.cleanup();
		}
	});

	it('creates a plan through the environment-only command', async () => {
		const context = fixture();
		const captured = capture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const code = await runCli(
				['qualify-oracle-live'],
				{
					CODE_INDEX_ROOT: context.config.rootDir,
					CODE_INDEX_EXTRACTOR: 'oracle',
					CODE_INDEX_PROJECT_FILE: context.config.projectFilePath,
					CODE_INDEX_DATABASE: context.config.databasePath,
					CODE_INDEX_ANALYTICS: 'false',
					CODE_INDEX_LOG_LEVEL: 'error',
					CODE_INDEX_QUALIFICATION_OUTPUT_DIR: outputDir,
				},
				captured.io,
			);

			expect(code).toBe(0);
			expect(captured.stdout.join('\n')).toContain('Approval:');
			expect(captured.stderr).toStrictEqual([]);
		} finally {
			context.cleanup();
		}
	});
});
