import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {GENERIC_ORACLE_CONTRACT_TESTS, discoveredOracleTestModules, oracleWorkflowTests} from './helpers/oracleWorkflow.ts';

const repositoryRoot = path.dirname(import.meta.dirname);

describe('Oracle test tier membership', () => {
	it('includes every Oracle module on disk', () => {
		const discovered = discoveredOracleTestModules(repositoryRoot);
		const selected = new Set(oracleWorkflowTests(repositoryRoot));

		expect(discovered.length).toBeGreaterThan(30);
		expect(discovered.filter((modulePath) => !selected.has(modulePath))).toStrictEqual([]);
	});

	it('carries the generic contracts Oracle depends on', () => {
		const selected = new Set(oracleWorkflowTests(repositoryRoot));

		expect(GENERIC_ORACLE_CONTRACT_TESTS.filter((modulePath) => !selected.has(modulePath))).toStrictEqual([]);
		expect(selected.size).toBe(discoveredOracleTestModules(repositoryRoot).length + GENERIC_ORACLE_CONTRACT_TESTS.length);
	});

	it('includes a newly added Oracle module without a configuration edit', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'codeindex-oracle-tier-'));

		try {
			await mkdir(path.join(root, 'test'), {recursive: true});
			await writeFile(path.join(root, 'test', 'oracleNewlyAdded.test.ts'), '', 'utf8');

			expect(discoveredOracleTestModules(root)).toStrictEqual(['test/oracleNewlyAdded.test.ts']);
		} finally {
			await rm(root, {recursive: true, force: true});
		}
	});

	it('rejects a tier that names a missing module', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'codeindex-oracle-tier-'));

		try {
			await mkdir(path.join(root, 'test'), {recursive: true});
			await writeFile(path.join(root, 'test', 'oracleOnly.test.ts'), '', 'utf8');

			expect(() => oracleWorkflowTests(root)).toThrow(/test modules that do not exist/u);
		} finally {
			await rm(root, {recursive: true, force: true});
		}
	});

	it('rejects an empty Oracle tier', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'codeindex-oracle-tier-'));

		try {
			await mkdir(path.join(root, 'test'), {recursive: true});

			expect(() => oracleWorkflowTests(root)).toThrow(/discovered no test modules/u);
		} finally {
			await rm(root, {recursive: true, force: true});
		}
	});
});
