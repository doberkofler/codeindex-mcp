import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import {PersistentBuildWorker} from '../src/core/generation/persistentBuildWorker.ts';
import {scanTypeScriptProject} from '@codeindex/adapter-typescript/index';
import {createFixtureConfig} from './helpers/fixture.ts';

const workerScript = `
import {parentPort} from 'node:worker_threads';
let count = 0;
parentPort.on('message', (message) => {
	if (message.kind === 'code-index-shutdown') {
		parentPort.close();
		return;
	}
	if (message.kind === 'code-index-build') {
		count += 1;
		parentPort.postMessage({
			kind: 'code-index-build-result',
			id: message.id,
			ok: true,
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
		});
	}
});
`;

const withWorker = async (
	options: Readonly<{idleMs?: number; maxProcessTreeRssBytes?: number}>,
	action: (worker: PersistentBuildWorker, run: () => Promise<number>) => Promise<void>,
): Promise<void> => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-persistent-'));
	const workerEntry = path.join(directory, 'worker.mjs');
	const {config, cleanup} = createFixtureConfig('simple-project');

	try {
		writeFileSync(workerEntry, workerScript, {encoding: 'utf8'});
		const scan = scanTypeScriptProject(config, []);
		const scans = [{adapterId: 'typescript', coverage: 'present' as const, absenceReason: null, scan}];
		const worker = new PersistentBuildWorker({
			workerEntry,
			descriptors: [],
			debug: false,
			idleMs: options.idleMs ?? 0,
			maxProcessTreeRssBytes: options.maxProcessTreeRssBytes ?? 1024 * 1024 * 1024,
		});
		const run = async (): Promise<number> => {
			const report = await worker.run({config, scans, force: false, ownerId: 'owner', startedAtEpoch: Date.now()});
			return report.revision;
		};

		try {
			await action(worker, run);
		} finally {
			await worker.close();
		}
	} finally {
		cleanup();
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('persistent build worker', () => {
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
});
