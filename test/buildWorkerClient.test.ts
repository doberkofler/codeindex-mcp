import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {runBuildWorkerThread} from '../src/core/generation/buildWorkerClient.ts';
import {type ScanResultType} from '../src/core/model.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const runWorkerScript = async (script: string): Promise<unknown> => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-worker-'));
	const workerEntry = path.join(directory, 'worker.mjs');
	const {config, cleanup} = createFixtureConfig('simple-project');

	try {
		writeFileSync(workerEntry, `${script}\n`, {encoding: 'utf8'});
		const scan: ScanResultType = typeScriptExtractor.scan(config, []);

		return await runBuildWorkerThread({workerEntry, config, scan, force: false, ownerId: 'test-owner', debug: false});
	} finally {
		rmSync(directory, {recursive: true, force: true});
		cleanup();
	}
};

describe('build worker client', () => {
	it('preserves the worker error instead of replacing it with the exit code', async () => {
		await expect(runWorkerScript("throw new Error('worker exploded')")).rejects.toThrow('worker exploded');
	});

	it('reports a structured worker failure', async () => {
		await expect(
			runWorkerScript("import {parentPort} from 'node:worker_threads'; parentPort?.postMessage({ok: false, message: 'worker said no'});"),
		).rejects.toThrow('worker said no');
	});

	it('reports an unexplained non-zero worker exit', async () => {
		await expect(runWorkerScript('process.exit(1);')).rejects.toThrow('Index build worker exited with code 1');
	});
});
