import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createOracleLivePlan} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {readOracleLiveSettings} from '../src/core/qualification/oracle/live/oracleLiveSettings.ts';
import {runOracleLiveQualification} from '../src/core/qualification/oracle/live/runOracleLiveQualification.ts';
import {runCli} from '../src/transports/cli/runCli.ts';
import {capture, fixture, settingsOf, sourceRows, stubDatabase} from './helpers/oracleLive.ts';

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
				{databaseFactory: stubDatabase(sourceRows(plan))},
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
			expect(captured.stdout.join('\n')).toMatch(/To apply: pnpm qualify:oracle:live --root /u);
			expect(captured.stdout.join('\n')).not.toContain('-- --root');

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
