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

const report = {
	generationId: 'generation',
	state: 'published',
	reused: false,
	durationMs: 12,
	fileCount: 1,
	symbolCount: 2,
	occurrenceCount: 3,
	dependencyEdgeCount: 4,
	dependencyBindingCount: 5,
	diagnosticCount: 6,
	stages: {scanMs: 1, compilerMs: 2, extractionMs: 3, insertionMs: 4, verificationMs: 5, publicationMs: 6},
};

describe('build worker client', () => {
	it('returns a validated build report', async () => {
		const actual = await runWorkerScript(
			`import {parentPort} from 'node:worker_threads'; parentPort?.postMessage({ok: true, report: ${JSON.stringify(report)}});`,
		);

		expect(actual).toStrictEqual(report);
	});

	it('accepts a report without stages', async () => {
		const withoutStages = {...report, stages: null};
		const actual = await runWorkerScript(
			`import {parentPort} from 'node:worker_threads'; parentPort?.postMessage({ok: true, report: ${JSON.stringify(withoutStages)}});`,
		);

		expect(actual).toStrictEqual(withoutStages);
	});

	it('rejects malformed reports and preserves worker messages', async () => {
		await expect(
			runWorkerScript(
				`import {parentPort} from 'node:worker_threads'; parentPort?.postMessage({ok: true, report: {generationId: 'generation', state: 'unknown'}});`,
			),
		).rejects.toThrow('Index build worker failed');

		await expect(
			runWorkerScript("import {parentPort} from 'node:worker_threads'; parentPort?.postMessage({ok: false, message: 'structured failure'});"),
		).rejects.toThrow('structured failure');
	});

	it('rejects every report field with a non-numeric or non-boolean value', async () => {
		const fields = [
			'generationId',
			'reused',
			'durationMs',
			'fileCount',
			'symbolCount',
			'occurrenceCount',
			'dependencyEdgeCount',
			'dependencyBindingCount',
			'diagnosticCount',
		] as const;

		await Promise.all(
			fields.map(async (field) => {
				const malformed = JSON.stringify({...report, [field]: field === 'generationId' || field === 'reused' ? 42 : 'invalid'});

				await expect(
					runWorkerScript(`import {parentPort} from 'node:worker_threads'; parentPort?.postMessage({ok: true, report: ${malformed}});`),
				).rejects.toThrow('Index build worker failed');
			}),
		);
	});

	it('discards incomplete or non-object stages', async () => {
		const stages = [null, [], {scanMs: 'invalid'}, {scanMs: 1}];
		const actualReports = await Promise.all(
			stages.map(async (value) => {
				const withoutStages = {...report, stages: value};
				const actual = await runWorkerScript(
					`import {parentPort} from 'node:worker_threads'; parentPort?.postMessage({ok: true, report: ${JSON.stringify(withoutStages)}});`,
				);

				return actual;
			}),
		);

		for (const actual of actualReports) {
			expect(actual).toMatchObject({stages: null});
		}
	});

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
