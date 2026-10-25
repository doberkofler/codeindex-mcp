import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {readInstalledOracleDependencies, readInstalledOracleSources} from '../src/core/qualification/oracle/live/oracleInventory.ts';
import {runOracleLiveQualification} from '../src/core/qualification/oracle/live/runOracleLiveQualification.ts';

/*
 * Opt-in live tier. Every step is read-only: it inspects the catalogue and
 * proves that an apply without a retained, approved plan performs no DDL.
 *
 * The module name deliberately avoids the `oracle*` prefix so deterministic
 * discovery never selects it.
 */

const FIXTURE_ROOT = 'test/fixtures/oracle-qualification-corpus';
const MANIFEST = path.join(FIXTURE_ROOT, 'oracle-index.json');
const enabled = process.env['CODE_INDEX_ORACLE_LIVE'] === '1';
const credentials = {
	server: process.env['ORACLE_SERVER'] ?? '',
	user: process.env['ORACLE_USER'] ?? '',
	password: process.env['ORACLE_PASSWORD'] ?? '',
};
const credentialsPresent = credentials.server !== '' && credentials.user !== '' && credentials.password !== '';

describe('Oracle live qualification preflight', () => {
	it.runIf(enabled)('reports missing read-only credentials instead of planning without a connection', () => {
		expect(credentialsPresent, 'Set ORACLE_SERVER, ORACLE_USER, and ORACLE_PASSWORD for the live tier.').toBe(true);
	});
});

describe.skipIf(!enabled || !credentialsPresent)('Oracle live qualification', () => {
	const workDirectory = {path: ''};

	afterAll(async () => {
		if (workDirectory.path !== '') {
			await rm(workDirectory.path, {recursive: true, force: true});
		}
	});

	it('reads the installed catalogue through a read-only inventory', async () => {
		const [sources, dependencies] = await Promise.all([readInstalledOracleSources(credentials), readInstalledOracleDependencies(credentials)]);

		expect(sources.size).toBeGreaterThan(0);
		expect([...sources.values()].some((source) => source.source.length > 0)).toBe(true);
		expect(dependencies.length).toBeGreaterThan(0);
	});

	it('refuses to apply without a retained approved plan', async () => {
		workDirectory.path = await mkdtemp(path.join(tmpdir(), 'codeindex-oracle-live-'));
		const stdout: string[] = [];

		const code = await runOracleLiveQualification(
			{
				HOME: process.env['HOME'] ?? '',
				PATH: process.env['PATH'] ?? '',
				ORACLE_SERVER: credentials.server,
				ORACLE_USER: credentials.user,
				ORACLE_PASSWORD: credentials.password,
			},
			{root: FIXTURE_ROOT, manifest: MANIFEST, output: workDirectory.path, approval: 'a'.repeat(64)},
			{
				stdout: (line) => {
					stdout.push(line);
				},
				stderr: (line) => {
					stdout.push(line);
				},
			},
		);

		expect(code).toBe(1);
		expect(existsSync(path.join(workDirectory.path, 'user-source-backup.csv'))).toBe(false);
		expect(existsSync(path.join(workDirectory.path, 'compile.log'))).toBe(false);
		expect(existsSync(path.join(workDirectory.path, 'invalid-objects.csv'))).toBe(false);
		expect(stdout.join('\n')).toContain('plan.json');
		expect(stdout.join('\n')).not.toContain(credentials.password);
	});
});
