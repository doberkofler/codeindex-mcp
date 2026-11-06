import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import {type ResolvedAdapterDescriptorType} from '../src/adapters/loader.ts';
import {createCodeIndex} from '../src/core/generation/codeIndex.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {testAdaptersFor} from './helpers/adapters.ts';
import {createFixtureConfig} from './helpers/fixture.ts';
import {silentLogger} from './helpers/silentLogger.ts';

// A build that never answers and ignores the cooperative cancel message. This is
// what a long single-adapter extraction looks like from the coordinator.
const hangingWorkerScript = `
import {parentPort} from 'node:worker_threads';
parentPort.on('message', () => {});
setInterval(() => {}, 1000);
`;

/**
 * Builds the descriptor that selects the worker build path.
 *
 * @param adapters - Test adapter set without descriptors.
 * @returns One worker-loadable descriptor per adapter.
 */
const workerDescriptorsOf = (adapters: readonly {id: string; version: string}[]): readonly ResolvedAdapterDescriptorType[] =>
	adapters.map((adapter) => ({
		id: adapter.id,
		moduleUrl: 'builtin:typescript',
		protocolVersion: 1,
		implementationVersion: adapter.version,
		packageName: null,
		packageVersion: null,
	}));

describe('CodeIndex close', () => {
	it('stops a pending build instead of waiting for its cooperative cancellation', async () => {
		const {config, cleanup} = createFixtureConfig('simple-project');
		const directory = mkdtempSync(path.join(tmpdir(), 'code-index-hanging-worker-'));
		const workerEntry = path.join(directory, 'worker.mjs');

		try {
			writeFileSync(workerEntry, hangingWorkerScript, {encoding: 'utf8'});
			const database = IndexDatabase.open(config.databasePath, {
				rootDir: config.rootDir,
				projectFilePath: config.projectFilePath,
				projectId: config.projectId,
				extractorId: config.extractorId,
			});
			const adapters = testAdaptersFor(config);
			const index = createCodeIndex(config, database, silentLogger, {
				watch: false,
				workerEntry,
				adapters: adapters.adapters,
				adapterDescriptors: workerDescriptorsOf(adapters.adapters),
			});
			const settled = (async (): Promise<string> => {
				try {
					await index.ensureReady();
					return 'resolved';
				} catch {
					return 'rejected';
				}
			})();

			// Let the scan finish and the worker build start.
			await delay(250);

			const startedAt = performance.now();
			await index.close();
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeLessThan(10_000);
			await expect(settled).resolves.toBe('rejected');
		} finally {
			cleanup();
			rmSync(directory, {recursive: true, force: true});
		}
	});
});
