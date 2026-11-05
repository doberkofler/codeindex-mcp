import {parentPort} from 'node:worker_threads';
import {isAdapterDescriptor, loadAdaptersFromDescriptors, type AdapterSetType, type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
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
	/** Exact module identities the parent selected; never functions. */
	descriptors: readonly ResolvedAdapterDescriptorType[];
	force: boolean;
	ownerId: string;
	/** Epoch milliseconds at which the parent attempt started, including its scan. */
	startedAtEpoch?: number;
	debug: boolean;
}>;

/** Worker payload that keeps one worker thread alive across build attempts. */
export type BuildWorkerHostDataType = Readonly<{
	kind: 'code-index-build-host';
	descriptors: readonly ResolvedAdapterDescriptorType[];
	debug: boolean;
}>;

/** One build request posted to a persistent worker. */
type BuildWorkerRequestType = Readonly<{
	kind: 'code-index-build';
	id: number;
	config: ConfigType;
	scans: readonly AdapterScanPlanType[];
	force: boolean;
	ownerId: string;
	startedAtEpoch?: number;
	debug: boolean;
}>;

type BuildWorkerCancelType = Readonly<{kind: 'code-index-cancel'; id: number}>;
type BuildWorkerShutdownType = Readonly<{kind: 'code-index-shutdown'}>;

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
const isWorkerConfig = (value: unknown): boolean =>
	isRecord(value) &&
	typeof value['databasePath'] === 'string' &&
	typeof value['rootDir'] === 'string' &&
	typeof value['projectFilePath'] === 'string' &&
	(Array.isArray(value['projects']) || Array.isArray(value['adapters'])) &&
	typeof value['extractorId'] === 'string';

const isScanPlan = (plan: unknown): boolean => {
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
};

const hasBuildFields = (value: Readonly<Record<string, unknown>>): boolean =>
	isWorkerConfig(value['config']) &&
	Array.isArray(value['scans']) &&
	value['scans'].length > 0 &&
	value['scans'].every((plan) => isScanPlan(plan)) &&
	typeof value['force'] === 'boolean' &&
	typeof value['ownerId'] === 'string';

export const isBuildWorkerData = (value: unknown): value is BuildWorkerDataType => {
	if (!isRecord(value) || value['kind'] !== 'code-index-build') {
		return false;
	}

	const {descriptors} = value;

	return Array.isArray(descriptors) && descriptors.length > 0 && descriptors.every((descriptor) => isAdapterDescriptor(descriptor)) && hasBuildFields(value);
};

/**
 * Recognises the persistent worker payload emitted by `CodeIndex`.
 *
 * @param value - Raw `workerData`.
 * @returns True when the worker should stay alive between build requests.
 */
export const isBuildWorkerHostData = (value: unknown): value is BuildWorkerHostDataType => {
	if (!isRecord(value) || value['kind'] !== 'code-index-build-host') {
		return false;
	}

	const {descriptors} = value;

	return Array.isArray(descriptors) && descriptors.length > 0 && descriptors.every((descriptor) => isAdapterDescriptor(descriptor));
};

/**
 * Recognises one request posted to a persistent worker.
 *
 * @param value - Raw worker message.
 * @returns True when the message carries one complete build request.
 */
const isBuildWorkerRequest = (value: unknown): value is BuildWorkerRequestType =>
	isRecord(value) && value['kind'] === 'code-index-build' && typeof value['id'] === 'number' && Number.isInteger(value['id']) && hasBuildFields(value);

const isCancelMessage = (value: unknown): value is BuildWorkerCancelType =>
	isRecord(value) && value['kind'] === 'code-index-cancel' && typeof value['id'] === 'number' && Number.isInteger(value['id']);

const isShutdownMessage = (value: unknown): value is BuildWorkerShutdownType => isRecord(value) && value['kind'] === 'code-index-shutdown';

const logger = createLogger({minimumLevel: 'error'});

/** Message posted by a build worker after one attempt. */
export type BuildWorkerMessageType = Readonly<{ok: true; report: BuildReportType}> | Readonly<{ok: false; failure: BuildFailureType}>;

/** Message posted by a persistent worker after one attempt. */
type BuildWorkerResultType =
	| Readonly<{kind: 'code-index-build-result'; id: number; ok: true; report: BuildReportType}>
	| Readonly<{kind: 'code-index-build-result'; id: number; ok: false; failure: BuildFailureType}>;

const projectContextOf = (plans: readonly AdapterScanPlanType[]): BuildProjectContextType | null => {
	const scan = plans.find((plan) => plan.scan !== null)?.scan;
	const project = scan?.projects.at(0);

	return project === undefined ? null : {name: project.name, file: project.projectFile};
};

const postResult = (id: number, message: BuildWorkerMessageType): void => {
	const result: BuildWorkerResultType = message.ok
		? {kind: 'code-index-build-result', id, ok: true, report: message.report}
		: {kind: 'code-index-build-result', id, ok: false, failure: message.failure};
	parentPort?.postMessage(result);
};

type BuildRequestType = Readonly<{
	config: ConfigType;
	scans: readonly AdapterScanPlanType[];
	force: boolean;
	ownerId: string;
	startedAtEpoch?: number | undefined;
}>;

const performBuild = async (request: BuildRequestType, adapters: AdapterSetType, isCancelled: () => boolean): Promise<BuildWorkerMessageType> => {
	let database: IndexDatabase | undefined;

	try {
		debug('opening database');
		database = runBuildStage('persistence', () =>
			IndexDatabase.open(request.config.databasePath, {
				rootDir: request.config.rootDir,
				projectId: request.config.projectId,
				projects: configuredAdapters(request.config).map((adapter) => {
					const scan = request.scans.find((plan) => plan.adapterId === adapter.id)?.scan ?? null;

					return {
						adapterId: adapter.id,
						projectId: request.config.projectId,
						projectFilePath: adapter.projectFilePath,
						compilerVersion: scan?.compilerVersion ?? 'unknown',
						extractorVersion: scan?.extractorVersion ?? 'unknown',
					};
				}),
			}),
		);
		debug('database opened');
		const report = await buildGeneration({
			config: request.config,
			database,
			logger,
			adapters,
			scans: request.scans,
			force: request.force,
			ownerId: request.ownerId,
			isCancelled,
			...(request.startedAtEpoch === undefined ? {} : {startedAtEpoch: request.startedAtEpoch}),
		});
		debug('build complete', {generationId: report.generationId, reused: report.reused, durationMs: report.durationMs});
		return {ok: true, report};
	} catch (error) {
		debug('build failed', {message: error instanceof Error ? error.message : String(error)});
		const {scans} = request;
		return {
			ok: false,
			failure: buildFailureOf(error, 'unknown', projectContextOf(scans), scans.length === 1 ? (scans[0]?.adapterId ?? null) : null),
		};
	} finally {
		// Completion is reported only after the worker's connections are closed.
		// The parent closes and reopens the same database as soon as it observes
		// the report, so an overlap would race the last-connection WAL checkpoint.
		database?.close();
	}
};

const disposeAdapters = (adapters: AdapterSetType | null): void => {
	for (const adapter of adapters?.adapters ?? []) {
		try {
			adapter.dispose?.();
		} catch (error) {
			debug('adapter dispose failed', {adapter: adapter.id, message: error instanceof Error ? error.message : String(error)});
		}
	}
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
export const runBuildWorker = async (data: BuildWorkerDataType): Promise<BuildWorkerMessageType> => {
	if (data.debug) {
		enableDebug();
	}

	let cancelled = false;
	let adapters: AdapterSetType | null = null;
	const onMessage = (value: unknown): void => {
		if (isRecord(value) && value['kind'] === 'code-index-cancel') {
			cancelled = true;
		}
	};
	parentPort?.on('message', onMessage);
	debug('build worker start', {rootDir: data.config.rootDir, adapters: data.scans.length, force: data.force});
	let message: BuildWorkerMessageType;

	try {
		adapters = await loadAdaptersFromDescriptors(data.descriptors);
		message = await performBuild(data, adapters, () => cancelled);
	} finally {
		parentPort?.off('message', onMessage);
		disposeAdapters(adapters);
	}

	parentPort?.postMessage(message);
	return message;
};

/**
 * Runs one persistent build worker.
 *
 * Adapter modules and their retained compiler sessions are loaded once and
 * reused by every request. Each request still opens and closes its own database
 * connection so publication keeps the existing WAL boundary.
 *
 * @param data - Validated persistent worker payload.
 * @returns Completion when the worker receives a shutdown request.
 */
export const runBuildWorkerHost = async (data: BuildWorkerHostDataType): Promise<void> => {
	if (data.debug) {
		enableDebug();
	}

	const adaptersPromise = loadAdaptersFromDescriptors(data.descriptors);
	let adapters: AdapterSetType | null = null;
	let current: {id: number; cancelled: boolean} | null = null;
	let closing = false;
	let finish: (() => void) | null = null;
	let currentDone: Promise<true> | null = null;
	const cancelledBeforeStart = new Set<number>();

	const handle = async (request: BuildWorkerRequestType): Promise<void> => {
		if (closing) {
			return;
		}

		if (current !== null) {
			postResult(request.id, {
				ok: false,
				failure: buildFailureOf(new Error('Build worker is already handling a request'), 'worker', projectContextOf(request.scans)),
			});
			return;
		}

		const state = {id: request.id, cancelled: cancelledBeforeStart.has(request.id)};
		cancelledBeforeStart.delete(request.id);
		current = state;
		const {promise: done, resolve: resolveDone} = Promise.withResolvers<true>();
		currentDone = done;
		debug('build request start', {id: request.id, rootDir: request.config.rootDir, adapters: request.scans.length});

		try {
			adapters ??= await adaptersPromise;
			postResult(request.id, await performBuild(request, adapters, () => state.cancelled));
		} catch (error) {
			postResult(request.id, {ok: false, failure: buildFailureOf(error, 'worker', projectContextOf(request.scans))});
		} finally {
			if (current === state) {
				current = null;
				currentDone = null;
			}

			resolveDone(true);
			debug('build request complete', {id: request.id});
		}
	};

	const close = async (): Promise<void> => {
		if (closing) {
			return;
		}

		closing = true;

		const active = current;
		const done = currentDone;

		if (active !== null && done !== null) {
			active.cancelled = true;
			await done;
		}

		try {
			adapters ??= await adaptersPromise;
		} catch {
			adapters = null;
		}

		disposeAdapters(adapters);
		parentPort?.close();
		finish?.();
	};

	const onMessage = (value: unknown): void => {
		if (isShutdownMessage(value)) {
			void close();
			return;
		}

		if (isCancelMessage(value)) {
			if (current?.id === value.id) {
				current.cancelled = true;
			} else {
				cancelledBeforeStart.add(value.id);
			}

			return;
		}

		if (isBuildWorkerRequest(value)) {
			void handle(value);
		}
	};

	parentPort?.on('message', onMessage);
	debug('persistent build worker ready', {adapters: data.descriptors.length});

	const {promise: lifetime, resolve} = Promise.withResolvers<true>();
	finish = (): void => {
		resolve(true);
	};
	await lifetime;
};
