import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {type AdapterSetType} from '../../adapters/loader.ts';
import {type ConfigType} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type CodeIndexOptionsType} from './codeIndexOptions.ts';
import {PersistentBuildWorker} from './persistentBuildWorker.ts';

const debug = debugFor('index');

/**
 * Selects and creates the persistent build worker for one index.
 *
 * A worker cannot rebuild without the parent's module descriptors, so an
 * adapter set without them stays in process instead of failing dispatch.
 *
 * @param config - Resolved configuration.
 * @param options - Runtime options, including worker overrides.
 * @param adapterSet - Loaded adapters and their worker descriptors.
 * @returns The selected entry and worker, or a null worker for in-process builds.
 */
export const buildWorkerOf = (
	config: ConfigType,
	options: CodeIndexOptionsType,
	adapterSet: AdapterSetType,
): Readonly<{entry: string | null; worker: PersistentBuildWorker | null}> => {
	const workerPath = fileURLToPath(new URL('buildWorker.js', import.meta.url));
	const entry =
		options.extractor === undefined && adapterSet.descriptors.length > 0 ? (options.workerEntry ?? (existsSync(workerPath) ? workerPath : null)) : null;

	if (entry === null) {
		return {entry, worker: null};
	}

	return {
		entry,
		worker: new PersistentBuildWorker({
			workerEntry: entry,
			descriptors: adapterSet.descriptors,
			debug: debug.enabled,
			idleMs: options.buildWorkerIdleMs ?? config.buildWorkerIdleMs ?? 60_000,
			maxProcessTreeRssBytes: options.buildWorkerMaxRssBytes ?? config.buildWorkerMaxRssBytes ?? 2 * 1024 * 1024 * 1024,
		}),
	};
};
