import {parentPort} from 'node:worker_threads';
import {configuredAdapters, type ConfigType} from '../config/config.ts';
import {debugFor, enableDebug} from '../logging/debug.ts';
import {createLogger} from '../logging/logger.ts';
import {type BuildReportType} from '../model.ts';
import {buildFailureOf, runBuildStage, type BuildFailureType, type BuildProjectContextType} from './buildFailure.ts';
import {type AdapterScanPlanType} from './adapterBuild.ts';
import {buildGeneration} from './buildGeneration.ts';
import {IndexDatabase} from '../storage/database.ts';

export type BuildWorkerDataType = Readonly<{
	kind: 'code-index-build';
	config: ConfigType;
	scans: readonly AdapterScanPlanType[];
	force: boolean;
	ownerId: string;
	/** Epoch milliseconds at which the parent attempt started, including its scan. */
	startedAtEpoch?: number;
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

	const {config, scans} = value;

	if (!isRecord(config) || !Array.isArray(scans)) {
		return false;
	}

	return (
		typeof config['databasePath'] === 'string' &&
		typeof config['rootDir'] === 'string' &&
		typeof config['projectFilePath'] === 'string' &&
		(Array.isArray(config['projects']) || Array.isArray(config['adapters'])) &&
		typeof config['extractorId'] === 'string' &&
		scans.length > 0 &&
		scans.every((plan) => {
			if (!isRecord(plan) || typeof plan['adapterId'] !== 'string') {
				return false;
			}

			if (plan['coverage'] === 'absent') {
				return true;
			}

			const {scan} = plan;

			return (
				plan['coverage'] === 'present' &&
				isRecord(scan) &&
				typeof scan['sourceHash'] === 'string' &&
				typeof scan['configHash'] === 'string' &&
				Array.isArray(scan['files'])
			);
		}) &&
		typeof value['force'] === 'boolean' &&
		typeof value['ownerId'] === 'string'
	);
};

const logger = createLogger({minimumLevel: 'error'});

/** Message posted by a build worker after one attempt. */
export type BuildWorkerMessageType = Readonly<{ok: true; report: BuildReportType}> | Readonly<{ok: false; failure: BuildFailureType}>;

const projectContextOf = (plans: readonly AdapterScanPlanType[]): BuildProjectContextType | null => {
	const scan = plans.find((plan) => plan.scan !== null)?.scan;
	const project = scan?.projects.at(0);

	return project === undefined ? null : {name: project.name, file: project.projectFile};
};

/**
 * Builds and publishes one generation inside a worker thread.
 *
 * Failures cross the thread boundary as a bounded envelope: cause, stage, errno,
 * and workspace-relative project context. The raw message and stack stay inside
 * the worker so neither can leak an absolute path.
 *
 * @param data - Validated worker payload.
 * @returns The message posted to the parent process.
 */
export const runBuildWorker = (data: BuildWorkerDataType): BuildWorkerMessageType => {
	if (data.debug) {
		enableDebug();
	}

	let database: IndexDatabase | undefined;
	let message: BuildWorkerMessageType;
	debug('build worker start', {rootDir: data.config.rootDir, adapters: data.scans.length, force: data.force});

	try {
		debug('opening database');
		database = runBuildStage('persistence', () =>
			IndexDatabase.open(data.config.databasePath, {
				rootDir: data.config.rootDir,
				projectId: data.config.projectId,
				projects: configuredAdapters(data.config).map((adapter) => {
					const scan = data.scans.find((plan) => plan.adapterId === adapter.id)?.scan ?? null;

					return {
						adapterId: adapter.id,
						projectId: data.config.projectId,
						projectFilePath: adapter.projectFilePath,
						compilerVersion: scan?.compilerVersion ?? 'unknown',
						extractorVersion: scan?.extractorVersion ?? 'unknown',
					};
				}),
			}),
		);
		debug('database opened');
		const report = buildGeneration({
			config: data.config,
			database,
			logger,
			scans: data.scans,
			force: data.force,
			ownerId: data.ownerId,
			...(data.startedAtEpoch === undefined ? {} : {startedAtEpoch: data.startedAtEpoch}),
		});
		debug('build worker complete', {generationId: report.generationId, reused: report.reused, durationMs: report.durationMs});
		message = {ok: true, report};
	} catch (error) {
		debug('build worker failed', {message: error instanceof Error ? error.message : String(error)});
		const {scans} = data;
		const [firstScan] = scans;
		message = {ok: false, failure: buildFailureOf(error, 'unknown', projectContextOf(scans), scans.length === 1 ? (firstScan?.adapterId ?? null) : null)};
	} finally {
		// Completion is reported only after the worker's connections are closed.
		// The parent closes and reopens the same database as soon as it observes
		// the report, so an overlap would race the last-connection WAL checkpoint.
		database?.close();
	}

	parentPort?.postMessage(message);
	return message;
};
