import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import {PersistentBuildWorker} from '../src/core/generation/persistentBuildWorker.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const workerScript = `
import {parentPort} from 'node:worker_threads';
let count = 0;
parentPort.on('message', (message) => {
	if (message.kind === 'code-index-shutdown') {
		parentPort.close();
		return;
	}
	if (message.kind === 'code-index-initialize') {
		parentPort.postMessage({kind: 'code-index-initialize-result', id: message.id, ok: true});
		return;
	}
	if (message.kind === 'code-index-build') {
		if ('scans' in message) {
			throw new Error('Main process sent materialized scans');
		}
		count += 1;
		parentPort.postMessage({
			kind: 'code-index-build-result',
			id: message.id,
			ok: true,
			result: {
				report: {
					generationId: 'generation',
					revision: count,
					state: 'published',
					outcome: 'published',
					reused: false,
					durationMs: 1,
					fileCount: 1,
					symbolCount: 1,
					occurrenceCount: 1,
					dependencyEdgeCount: 0,
					dependencyBindingCount: 0,
					diagnosticCount: 0,
					stages: null,
				},
				watchInputs: [],
				compilerDrifts: [],
				resources: {processTreeRssPeakBytes: 2},
			},
		});
	}
});
`;

const withWorker = async (
	options: Readonly<{idleMs?: number; maxProcessTreeRssBytes?: number; script?: string}>,
	action: (worker: PersistentBuildWorker, run: () => Promise<number>, initialize: () => Promise<void>) => Promise<void>,
): Promise<void> => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-persistent-'));
	const workerEntry = path.join(directory, 'worker.mjs');
	const {config, cleanup} = createFixtureConfig('simple-project');

	try {
		writeFileSync(workerEntry, options.script ?? workerScript, {encoding: 'utf8'});
		const worker = new PersistentBuildWorker({
			workerEntry,
			descriptors: [],
			debug: false,
			idleMs: options.idleMs ?? 0,
			maxProcessTreeRssBytes: options.maxProcessTreeRssBytes ?? 1024 * 1024 * 1024,
		});
		const run = async (): Promise<number> => {
			const result = await worker.run({config, adapterIds: null, force: false, ownerId: 'owner', startedAtEpoch: Date.now()});
			return result.report.revision;
		};

		try {
			await action(worker, run, worker.initialize.bind(worker, config, {}));
		} finally {
			await worker.close();
		}
	} finally {
		cleanup();
		rmSync(directory, {recursive: true, force: true});
	}
};

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
	try {
		return await promise;
	} catch (error) {
		return error;
	}
};

describe('persistent build worker', () => {
	it('initializes writable storage inside the retained worker', async () => {
		await withWorker({}, async (_worker, _run, initialize) => {
			await expect(initialize()).resolves.toBeUndefined();
		});
	});

	it('reuses one worker thread across build attempts', async () => {
		await withWorker({}, async (_worker, run) => {
			await expect(run()).resolves.toBe(1);
			await expect(run()).resolves.toBe(2);
		});
	});

	it('stops an idle worker and starts a fresh one for the next attempt', async () => {
		await withWorker({idleMs: 20}, async (_worker, run) => {
			await expect(run()).resolves.toBe(1);
			await delay(100);
			await expect(run()).resolves.toBe(1);
		});
	});

	it('restarts the worker when the process-tree memory ceiling is exceeded', async () => {
		await withWorker({maxProcessTreeRssBytes: 1}, async (_worker, run) => {
			await expect(run()).resolves.toBe(1);
			await expect(run()).resolves.toBe(1);
		});
	});

	it('bounds a retained-worker crash without leaking its message', async () => {
		await withWorker(
			{
				script: `import {parentPort} from 'node:worker_threads';
					parentPort.on('message', (message) => {
						if (message.kind === 'code-index-build') {
							throw new Error('/private/workspace/secret.ts');
						}
					});`,
			},
			async (_worker, run) => {
				const error = await failureOf(run());

				expect(error).toBeInstanceOf(Error);
				expect(String(error)).toContain('Index build failed');
				expect(String(error)).not.toContain('/private/workspace');
				expect(String(error)).not.toContain('secret.ts');
			},
		);
	});

	it('settles synchronous work through the shared cancellation cell on close', async () => {
		await withWorker(
			{
				script: `import {parentPort} from 'node:worker_threads';
					parentPort.on('message', (message) => {
						if (message.kind === 'code-index-shutdown') {
							parentPort.close();
							return;
						}
						if (message.kind !== 'code-index-build') return;
						const cell = new Int32Array(message.cancellationBuffer);
						while (Atomics.load(cell, 0) === 0) {}
						parentPort.postMessage({kind: 'code-index-build-result', id: message.id, ok: false, failure: {
							outcome: 'failed', cause: 'worker', stage: 'worker', errno: null, project: null, adapter: null
						}});
					});`,
			},
			async (worker, run) => {
				const pending = failureOf(run());
				await delay(20);
				const startedAt = performance.now();
				await worker.close();

				expect(performance.now() - startedAt).toBeLessThan(500);
				await expect(pending).resolves.toBeInstanceOf(Error);
			},
		);
	});
});
