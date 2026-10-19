import {parentPort} from 'node:worker_threads';
import {type ConfigType} from '../config/config.ts';
import {debugFor, enableDebug} from '../logging/debug.ts';
import {createLogger} from '../logging/logger.ts';
import {type ScanResultType} from '../model.ts';
import {buildGeneration} from './buildGeneration.ts';
import {IndexDatabase} from '../storage/database.ts';

export type BuildWorkerDataType = Readonly<{
	kind: 'code-index-build';
	config: ConfigType;
	scan: ScanResultType;
	force: boolean;
	ownerId: string;
	debug: boolean;
}>;

const debug = debugFor('worker');

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

/**
 * Recognises the worker payload emitted by `CodeIndex`.
 *
 * Only the fields needed to start a build are checked. The payload is created
 * by this process and never accepted from a tool caller.
 *
 * @param value - Raw `workerData`.
 * @returns True when the payload can start a build.
 */
export const isBuildWorkerData = (value: unknown): value is BuildWorkerDataType => {
	if (!isRecord(value) || value['kind'] !== 'code-index-build') {
		return false;
	}

	const {config, scan} = value;

	if (!isRecord(config) || !isRecord(scan)) {
		return false;
	}

	return (
		typeof config['databasePath'] === 'string' &&
		typeof config['rootDir'] === 'string' &&
		typeof config['projectFilePath'] === 'string' &&
		Array.isArray(config['projects']) &&
		typeof config['extractorId'] === 'string' &&
		typeof scan['sourceHash'] === 'string' &&
		typeof scan['configHash'] === 'string' &&
		Array.isArray(scan['files']) &&
		typeof value['force'] === 'boolean' &&
		typeof value['ownerId'] === 'string'
	);
};

const logger = createLogger({minimumLevel: 'error'});

/**
 * Builds and publishes one generation inside a worker thread.
 *
 * @param data - Validated worker payload.
 */
export const runBuildWorker = (data: BuildWorkerDataType): void => {
	if (data.debug) {
		enableDebug();
	}

	let database: IndexDatabase | undefined;
	debug('build worker start', {rootDir: data.config.rootDir, files: data.scan.files.length, force: data.force});

	try {
		database = IndexDatabase.open(data.config.databasePath, {
			rootDir: data.config.rootDir,
			projectFilePath: data.config.projectFilePath,
			projectId: data.config.projectId,
			extractorId: data.scan.extractorId,
			compilerVersion: data.scan.compilerVersion,
			extractorVersion: data.scan.extractorVersion,
		});
		const report = buildGeneration({config: data.config, database, logger, scan: data.scan, force: data.force, ownerId: data.ownerId});
		debug('build worker complete', {generationId: report.generationId, reused: report.reused, durationMs: report.durationMs});
		parentPort?.postMessage({ok: true, report});
	} catch (error) {
		debug('build worker failed', {message: error instanceof Error ? error.message : String(error)});
		parentPort?.postMessage({ok: false, message: error instanceof Error ? error.message : String(error)});
	} finally {
		database?.close();
	}
};
