import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {createOracleLivePlan} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {runOracleLiveQualification} from '../src/core/qualification/oracle/live/runOracleLiveQualification.ts';
import {capture, fixture, installedSourcesOf, settingsOf, sourceRows, type StubDatabaseType} from './helpers/oracleLive.ts';

const oracleState = vi.hoisted(() => ({
	sources: [] as (readonly unknown[])[],
	dependencies: [] as (readonly unknown[])[],
}));

// oxlint-disable-next-line vitest/prefer-import-in-mock -- The optional native driver is absent; the stub is the contract under test.
vi.mock('oracledb', () => ({
	default: {
		OUT_FORMAT_ARRAY: 4001,
		getConnection: async (): Promise<
			Readonly<{
				execute: (sql: string) => Promise<{rows: readonly (readonly unknown[])[]}>;
				close: () => Promise<void>;
			}>
		> => {
			await Promise.resolve();

			return {
				execute: async (sql: string): Promise<{rows: readonly (readonly unknown[])[]}> => {
					await Promise.resolve();
					return {rows: sql.includes('FROM user_source') ? oracleState.sources : sql.includes('FROM user_dependencies') ? oracleState.dependencies : []};
				},
				close: async (): Promise<void> => {
					await Promise.resolve();
				},
			};
		},
	},
}));

const outputOf = (context: ReturnType<typeof fixture>, name = 'qualification'): string => path.join(path.dirname(context.config.rootDir), name);

const installedRows = (context: ReturnType<typeof fixture>): readonly (readonly unknown[])[] =>
	[...installedSourcesOf(context.config).values()].flatMap((entry) => entry.source.split('\n').map((text, index) => [entry.type, entry.name, index + 1, text]));

const databaseFactoryOf =
	(
		plan: ReturnType<typeof createOracleLivePlan>,
		baseline: readonly (readonly unknown[])[],
		validation: readonly (readonly unknown[])[],
	): (() => Promise<StubDatabaseType>) =>
	async () => {
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
					return invalidQueries === 1 ? baseline : validation;
				}

				if (sql.includes('FROM user_identifiers') || sql.includes('FROM user_dependencies')) {
					return [];
				}

				throw new Error(`Unexpected SQL: ${sql}`);
			},
			execute: async (): Promise<void> => {
				await Promise.resolve();
			},
			close: async (): Promise<void> => {
				await Promise.resolve();
			},
		};
	};

describe('Oracle live qualification planning coverage', () => {
	it('reads installed source and dependencies when a connection is configured', async () => {
		const context = fixture();
		const captured = capture();
		const output = outputOf(context, 'connected');

		try {
			oracleState.sources = [...installedRows(context)];
			oracleState.dependencies = [];
			const code = await runOracleLiveQualification(
				{ORACLE_SERVER: 'server', ORACLE_USER: 'HR', ORACLE_PASSWORD: 'secret'},
				{root: context.config.rootDir, output, schema: 'HR'},
				captured.io,
			);

			expect(code).toBe(0);
			expect(captured.stderr).toStrictEqual([]);
			expect(captured.stdout.join('\n')).toContain('Installed objects:');
			expect(captured.stdout.join('\n')).toContain('Dependents: 0');
			expect(existsSync(path.join(output, 'plan.json'))).toBe(true);
		} finally {
			oracleState.sources = [];
			context.cleanup();
		}
	});

	it('uses an explicit manifest, environment schema fallback, and quoted apply arguments', async () => {
		const context = fixture();
		const captured = capture();
		const output = outputOf(context, 'with space');

		try {
			const code = await runOracleLiveQualification(
				{ORACLE_USER: 'HR'},
				{root: context.config.rootDir, manifest: path.join(context.config.rootDir, 'oracle-index.json'), output},
				captured.io,
			);

			expect(code).toBe(0);
			expect(captured.stdout.join('\n')).toContain('Schema: HR');
			expect(captured.stdout.join('\n')).toContain('No database connection has been made');
			expect(captured.stdout.join('\n')).toContain(`Manifest: ${path.join(context.config.rootDir, 'oracle-index.json')}`);
			expect(captured.stdout.join('\n')).toContain(JSON.stringify(output));
		} finally {
			context.cleanup();
		}
	});

	it('rejects an invalid root, manifest, missing schema, unsafe output, and incomplete approval', async () => {
		const context = fixture();
		const captured = capture();
		const output = outputOf(context, 'errors');

		try {
			const missingRoot = await runOracleLiveQualification({}, {root: path.join(context.config.rootDir, 'missing')}, captured.io);
			expect(missingRoot).toBe(1);
			expect(captured.stderr.at(-1)).toContain('is not a directory');

			const fileRoot = await runOracleLiveQualification({}, {root: path.join(context.config.rootDir, 'oracle-index.json')}, captured.io);
			expect(fileRoot).toBe(1);

			const directoryManifest = await runOracleLiveQualification(
				{},
				{root: context.config.rootDir, manifest: path.join(context.config.rootDir, 'database'), output},
				captured.io,
			);
			expect(directoryManifest).toBe(1);
			expect(captured.stderr.at(-1)).toContain('is not a file');

			const missingSchema = await runOracleLiveQualification({}, {root: context.config.rootDir, output}, captured.io);
			expect(missingSchema).toBe(1);
			expect(captured.stderr.at(-1)).toContain('requires --schema or ORACLE_USER');

			const unsafeOutput = await runOracleLiveQualification(
				{},
				{root: context.config.rootDir, schema: 'HR', output: path.join(context.config.rootDir, 'inside')},
				captured.io,
			);
			expect(unsafeOutput).toBe(1);
			expect(captured.stderr.at(-1)).toContain('outside the indexed workspace');

			const incompleteApproval = await runOracleLiveQualification(
				{ORACLE_USER: 'HR'},
				{root: context.config.rootDir, output, approval: '0'.repeat(64)},
				captured.io,
			);
			expect(incompleteApproval).toBe(1);
			expect(captured.stderr.at(-1)).toContain('requires ORACLE_SERVER, ORACLE_USER, and ORACLE_PASSWORD');

			const invalidTimeout = await runOracleLiveQualification(
				{CODE_INDEX_ORACLE_TIMEOUT_MS: 'nope'},
				{root: context.config.rootDir, schema: 'HR', output},
				captured.io,
			);
			expect(invalidTimeout).toBe(1);
			expect(captured.stderr.at(-1)).toContain('Invalid Oracle live qualification environment');
		} finally {
			context.cleanup();
		}
	});
});

describe('Oracle live qualification apply reporting', () => {
	it('reports restored baseline objects and writes run metadata', async () => {
		const context = fixture();
		const captured = capture();
		const output = outputOf(context, 'restored');

		try {
			const plan = createOracleLivePlan(context.config, settingsOf(output));
			const code = await runOracleLiveQualification(
				{ORACLE_SERVER: 'server', ORACLE_USER: 'HR', ORACLE_PASSWORD: 'secret'},
				{root: context.config.rootDir, output, approval: plan.approval},
				captured.io,
				{databaseFactory: databaseFactoryOf(plan, [['VIEW', 'LEGACY_VIEW', 'INVALID']], [])},
			);
			const metadata = JSON.parse(readFileSync(plan.output.run, 'utf8')) as {
				contract: {id: string; version: string; truthPolicy: string};
				truth: {rows: number; excludedByReason: Record<string, number>};
				invalidObjects: {baseline: number; remainingBaseline: string[]; restoredBaseline: string[]};
				artifacts: {report: string};
			};

			expect([0, 1]).toContain(code);
			expect(captured.stdout.join('\n')).toContain('Baseline invalid objects: 1');
			expect(captured.stdout.join('\n')).toContain('Restored: 1');
			expect(captured.stdout.join('\n')).not.toContain('Still invalid');
			expect(metadata.contract).toMatchObject({id: 'oracle-o1', version: '2', truthPolicy: 'v4'});
			expect(metadata.truth.rows).toBe(0);
			expect(metadata.truth.excludedByReason).toMatchObject({omitted_ambiguous_overload: 0});
			expect(metadata.invalidObjects).toStrictEqual({baseline: 1, remainingBaseline: [], restoredBaseline: ['VIEW LEGACY_VIEW']});
			expect(existsSync(metadata.artifacts.report)).toBe(true);
		} finally {
			context.cleanup();
		}
	});

	it('reports baseline objects that remain invalid and returns the qualification code', async () => {
		const context = fixture();
		const captured = capture();
		const output = outputOf(context, 'remaining');

		try {
			const plan = createOracleLivePlan(context.config, settingsOf(output));
			const baseline = [['VIEW', 'LEGACY_VIEW', 'INVALID']];
			const code = await runOracleLiveQualification(
				{ORACLE_SERVER: 'server', ORACLE_USER: 'HR', ORACLE_PASSWORD: 'secret'},
				{root: context.config.rootDir, output, approval: plan.approval},
				captured.io,
				{databaseFactory: databaseFactoryOf(plan, baseline, baseline)},
			);

			expect([0, 1]).toContain(code);
			expect(captured.stdout.join('\n')).toContain('Still invalid: VIEW LEGACY_VIEW');
		} finally {
			context.cleanup();
		}
	});

	it('returns one and writes the error when the apply path throws', async () => {
		const context = fixture();
		const captured = capture();
		const output = outputOf(context, 'failed-apply');

		try {
			const plan = createOracleLivePlan(context.config, settingsOf(output));
			const code = await runOracleLiveQualification(
				{ORACLE_SERVER: 'server', ORACLE_USER: 'HR', ORACLE_PASSWORD: 'secret'},
				{root: context.config.rootDir, output, approval: plan.approval},
				captured.io,
				{
					databaseFactory: async () => {
						await Promise.resolve();
						throw new Error('driver unavailable');
					},
				},
			);

			expect(code).toBe(1);
			expect(captured.stderr).toStrictEqual(['driver unavailable']);
		} finally {
			context.cleanup();
		}
	});

	it('creates the output directory before reading an invalid plan', async () => {
		const context = fixture();
		const captured = capture();
		const output = outputOf(context, 'missing-plan');

		try {
			mkdirSync(path.dirname(output), {recursive: true});
			const code = await runOracleLiveQualification(
				{ORACLE_SERVER: 'server', ORACLE_USER: 'HR', ORACLE_PASSWORD: 'secret'},
				{root: context.config.rootDir, output, approval: '0'.repeat(64)},
				captured.io,
			);

			expect(code).toBe(1);
			expect(existsSync(output)).toBe(true);
			expect(captured.stderr.join('\n')).toContain('ENOENT');
		} finally {
			context.cleanup();
		}
	});
});
