import {parentPort} from 'node:worker_threads';
import {type AdapterWatchPlanType} from '@codeindex/adapter-sdk';
import {isAdapterDescriptor, loadAdaptersFromDescriptors, type AdapterSetType, type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
import {configuredAdapters, type ConfigType} from '../config/config.ts';
import {debugFor, enableDebug} from '../logging/debug.ts';
import {createLogger} from '../logging/logger.ts';
import {type BuildReportType} from '../model.ts';
import {startProcessSample} from '../resources/processSample.ts';
import {BUILD_LEASE_TTL_MS, IndexDatabase, type DatabaseOpenContextType} from '../storage/database.ts';
import {startBuildLeaseHeartbeat} from './buildLeaseHeartbeat.ts';
import {adapterTargets, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {adapterTargetsForScope} from './adapterRefresh.ts';
import {buildFailureOf, type BuildFailureType, type BuildProjectContextType, runBuildStage} from './buildFailure.ts';
import {buildGeneration} from './buildGeneration.ts';
import {executionContextOf} from './executionCancellation.ts';
import {acquireOrObserveBuildLease, externalBuildReport} from './externalBuild.ts';
import {createAdapterWatchPlans, mergeAdapterWatchPlans, watchPlansMatchTargets} from './adapterWatchPlans.ts';
import {type BuildProgressType} from './buildProgress.ts';

const LEASE_RENEW_MS = 3000;
const debug = debugFor('worker');
const logger = createLogger({minimumLevel: 'error'});

export type BuildWorkerDataType = Readonly<{
	kind: 'code-index-build';
	config: ConfigType;
	adapterIds: readonly string[] | null;
	/** Exact module identities the parent selected; never functions. */
	descriptors: readonly ResolvedAdapterDescriptorType[];
	force: boolean;
	ownerId: string;
	cancellationBuffer: SharedArrayBuffer;
	startedAtEpoch?: number;
	debug: boolean;
}>;

/** Worker payload that keeps one worker thread alive across build attempts. */
export type BuildWorkerHostDataType = Readonly<{
	kind: 'code-index-build-host';
	descriptors: readonly ResolvedAdapterDescriptorType[];
	debug: boolean;
}>;

/** Serializable compiler-version drift observed by one scan. */
type BuildWorkerCompilerDriftType = Readonly<{
	readonly compilerVersion: string;
	readonly declaredCompilerVersion: string | null;
}>;

/** Successful retained-worker result. */
export type BuildWorkerRunResultType = Readonly<{
	readonly report: BuildReportType;
	readonly watchPlans: readonly AdapterWatchPlanType[];
	readonly compilerDrifts: readonly BuildWorkerCompilerDriftType[];
	readonly resources: Readonly<Record<string, number>>;
}>;

/** One build request posted to a persistent worker. */
type BuildWorkerRequestType = Readonly<{
	kind: 'code-index-build';
	id: number;
	config: ConfigType;
	adapterIds: readonly string[] | null;
	force: boolean;
	ownerId: string;
	cancellationBuffer: SharedArrayBuffer;
	startedAtEpoch?: number;
	debug: boolean;
}>;

type BuildWorkerShutdownType = Readonly<{kind: 'code-index-shutdown'}>;
type BuildWorkerInitializeRequestType = Readonly<{
	kind: 'code-index-initialize';
	id: number;
	config: ConfigType;
	context: DatabaseOpenContextType;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

const isWorkerConfig = (value: unknown): boolean =>
	isRecord(value) &&
	typeof value['databasePath'] === 'string' &&
	typeof value['rootDir'] === 'string' &&
	typeof value['projectFilePath'] === 'string' &&
	(Array.isArray(value['projects']) || Array.isArray(value['adapters'])) &&
	typeof value['extractorId'] === 'string';

const isAdapterScope = (value: unknown): value is readonly string[] | null =>
	value === null || (Array.isArray(value) && value.every((adapterId) => typeof adapterId === 'string'));

const hasBuildFields = (value: Readonly<Record<string, unknown>>): boolean =>
	isWorkerConfig(value['config']) &&
	isAdapterScope(value['adapterIds']) &&
	typeof value['force'] === 'boolean' &&
	typeof value['ownerId'] === 'string' &&
	value['cancellationBuffer'] instanceof SharedArrayBuffer;

export const isBuildWorkerData = (value: unknown): value is BuildWorkerDataType => {
	if (!isRecord(value) || value['kind'] !== 'code-index-build') {
		return false;
	}

	const {descriptors} = value;
	return Array.isArray(descriptors) && descriptors.length > 0 && descriptors.every((descriptor) => isAdapterDescriptor(descriptor)) && hasBuildFields(value);
};

export const isBuildWorkerHostData = (value: unknown): value is BuildWorkerHostDataType => {
	if (!isRecord(value) || value['kind'] !== 'code-index-build-host') {
		return false;
	}

	const {descriptors} = value;
	return Array.isArray(descriptors) && descriptors.length > 0 && descriptors.every((descriptor) => isAdapterDescriptor(descriptor));
};

const isBuildWorkerRequest = (value: unknown): value is BuildWorkerRequestType =>
	isRecord(value) && value['kind'] === 'code-index-build' && typeof value['id'] === 'number' && Number.isInteger(value['id']) && hasBuildFields(value);

const isShutdownMessage = (value: unknown): value is BuildWorkerShutdownType => isRecord(value) && value['kind'] === 'code-index-shutdown';

const isInitializeRequest = (value: unknown): value is BuildWorkerInitializeRequestType =>
	isRecord(value) &&
	value['kind'] === 'code-index-initialize' &&
	typeof value['id'] === 'number' &&
	Number.isInteger(value['id']) &&
	isWorkerConfig(value['config']) &&
	isRecord(value['context']);

/** Message posted by a build worker after one attempt. */
export type BuildWorkerMessageType = Readonly<{ok: true; result: BuildWorkerRunResultType}> | Readonly<{ok: false; failure: BuildFailureType}>;

type BuildWorkerResultType =
	| Readonly<{kind: 'code-index-build-result'; id: number; ok: true; result: BuildWorkerRunResultType}>
	| Readonly<{kind: 'code-index-build-result'; id: number; ok: false; failure: BuildFailureType}>;

type BuildWorkerProgressMessageType = Readonly<{kind: 'code-index-build-progress'; id: number; progress: BuildProgressType}>;

type BuildWorkerInitializeResultType =
	| Readonly<{kind: 'code-index-initialize-result'; id: number; ok: true}>
	| Readonly<{kind: 'code-index-initialize-result'; id: number; ok: false; failure: BuildFailureType}>;

const projectContextOf = (plans: readonly AdapterScanPlanType[]): BuildProjectContextType | null => {
	const scan = plans.find((plan) => plan.scan !== null)?.scan;
	const project = scan?.projects.at(0);
	return project === undefined ? null : {name: project.name, file: project.projectFile};
};

const postResult = (id: number, message: BuildWorkerMessageType): void => {
	const result: BuildWorkerResultType = message.ok
		? {kind: 'code-index-build-result', id, ok: true, result: message.result}
		: {kind: 'code-index-build-result', id, ok: false, failure: message.failure};
	parentPort?.postMessage(result);
};

const postProgress = (id: number, progress: BuildProgressType): void => {
	const message: BuildWorkerProgressMessageType = {kind: 'code-index-build-progress', id, progress};
	parentPort?.postMessage(message);
};

type BuildRequestType = Readonly<{
	config: ConfigType;
	adapterIds: readonly string[] | null;
	force: boolean;
	ownerId: string;
	cancellationBuffer: SharedArrayBuffer;
	startedAtEpoch?: number | undefined;
}>;

const compilerDriftsOf = (plans: readonly AdapterScanPlanType[]): readonly BuildWorkerCompilerDriftType[] =>
	plans.flatMap((plan) =>
		plan.scan?.compilerDrift === true ? [{compilerVersion: plan.scan.compilerVersion, declaredCompilerVersion: plan.scan.declaredCompilerVersion}] : [],
	);

const databaseContextOf = (config: ConfigType, scans: readonly AdapterScanPlanType[]): DatabaseOpenContextType => ({
	rootDir: config.rootDir,
	projectId: config.projectId,
	projects: configuredAdapters(config).map((adapter) => {
		const scan = scans.find((plan) => plan.adapterId === adapter.id)?.scan ?? null;
		return {
			adapterId: adapter.id,
			projectId: config.projectId,
			projectFilePath: adapter.projectFilePath,
			compilerVersion: scan?.compilerVersion ?? 'unknown',
			extractorVersion: scan?.extractorVersion ?? 'unknown',
		};
	}),
});

const initializeWatchPlans = (database: IndexDatabase, config: ConfigType, adapters: AdapterSetType): readonly AdapterTargetType[] => {
	const targets = adapterTargets(config, adapters);
	const restored = database.getWatchPlans();

	if (!watchPlansMatchTargets(restored, targets)) {
		database.putWatchPlans(createAdapterWatchPlans(config, targets, null));
	}

	return targets;
};

const completeWatchPlans = (
	database: IndexDatabase,
	targets: readonly AdapterTargetType[],
	updates: readonly AdapterWatchPlanType[],
	outcome: BuildReportType['outcome'],
): readonly AdapterWatchPlanType[] => {
	if (outcome === 'superseded') {
		return database.getWatchPlans();
	}

	const plans = mergeAdapterWatchPlans(database.getWatchPlans(), updates, targets);
	database.putWatchPlans(plans);
	return plans;
};

const performBuild = async (
	request: BuildRequestType,
	adapters: AdapterSetType,
	onProgress?: (progress: BuildProgressType) => void,
): Promise<BuildWorkerMessageType> => {
	const sample = startProcessSample();
	const executionContext = executionContextOf(request.cancellationBuffer);
	let database: IndexDatabase | undefined;
	let stopHeartbeat: (() => void) | undefined;
	let leaseAcquired = false;
	let scans: readonly AdapterScanPlanType[] = [];
	let watchPlanUpdates: readonly AdapterWatchPlanType[] = [];
	let sampledResources: Readonly<Record<string, number>> | null = null;
	const resources = (): Readonly<Record<string, number>> => {
		sampledResources ??= {...sample.stop(), databaseBytes: database?.databaseSizeBytes() ?? 0};
		return sampledResources;
	};

	try {
		debug('opening database');
		database = runBuildStage('persistence', () => IndexDatabase.open(request.config.databasePath, databaseContextOf(request.config, scans)));
		debug('database opened');
		const targets = initializeWatchPlans(database, request.config, adapters);
		const requestedTargets = adapterTargetsForScope(targets, request.adapterIds);
		const startedAt = performance.now();
		const startedAtEpoch = request.startedAtEpoch ?? Date.now();
		const leaseOutcome = await acquireOrObserveBuildLease({
			database,
			requestedAdapterIds: requestedTargets.map((target) => target.adapter.id),
			startedAt,
			isCancelled: executionContext.isCancellationRequested,
			tryAcquire: () => database?.tryAcquireBuildLease(request.ownerId, process.pid, BUILD_LEASE_TTL_MS) ?? false,
		});
		const externalReport = externalBuildReport(leaseOutcome, database, startedAtEpoch);

		if (externalReport !== null) {
			return {ok: true, result: {report: externalReport, watchPlans: database.getWatchPlans(), compilerDrifts: [], resources: resources()}};
		}

		leaseAcquired = true;
		stopHeartbeat = startBuildLeaseHeartbeat({
			renew: () => database?.renewBuildLease(request.ownerId, BUILD_LEASE_TTL_MS) ?? false,
			intervalMs: LEASE_RENEW_MS,
			onFailure: (failure, error): void => {
				debug('build lease renewal skipped', {failure, message: error instanceof Error ? error.message : null});
			},
		});
		const report = await buildGeneration({
			config: request.config,
			database,
			logger,
			adapters,
			adapterIds: request.adapterIds,
			force: request.force,
			ownerId: request.ownerId,
			startedAtEpoch,
			isCancelled: executionContext.isCancellationRequested,
			executionContext,
			onScans: (captured): void => {
				scans = captured;
				watchPlanUpdates = createAdapterWatchPlans(request.config, targets, captured);
			},
			...(onProgress === undefined ? {} : {onProgress}),
		});
		const watchPlans = completeWatchPlans(database, targets, watchPlanUpdates, report.outcome);
		debug('build complete', {generationId: report.generationId, reused: report.reused, durationMs: report.durationMs});
		return {
			ok: true,
			result: {
				report,
				watchPlans,
				compilerDrifts: compilerDriftsOf(scans),
				resources: resources(),
			},
		};
	} catch (error) {
		debug('build failed', {message: error instanceof Error ? error.message : String(error)});
		return {ok: false, failure: buildFailureOf(error, 'unknown', projectContextOf(scans), scans.length === 1 ? (scans[0]?.adapterId ?? null) : null)};
	} finally {
		resources();
		stopHeartbeat?.();

		if (leaseAcquired) {
			try {
				database?.releaseBuildLease(request.ownerId);
			} catch (error) {
				debug('build lease release failed', {message: error instanceof Error ? error.message : String(error)});
			}
		}

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

const initializeStorage = (request: BuildWorkerInitializeRequestType, adapters: AdapterSetType): void => {
	let database: IndexDatabase | undefined;

	try {
		database = IndexDatabase.open(request.config.databasePath, request.context);
		initializeWatchPlans(database, request.config, adapters);
		const result: BuildWorkerInitializeResultType = {kind: 'code-index-initialize-result', id: request.id, ok: true};
		parentPort?.postMessage(result);
	} catch (error) {
		const result: BuildWorkerInitializeResultType = {
			kind: 'code-index-initialize-result',
			id: request.id,
			ok: false,
			failure: buildFailureOf(error, 'persistence'),
		};
		parentPort?.postMessage(result);
	} finally {
		database?.close();
	}
};

export const runBuildWorker = async (data: BuildWorkerDataType): Promise<BuildWorkerMessageType> => {
	if (data.debug) {
		enableDebug();
	}

	let adapters: AdapterSetType | null = null;
	let message: BuildWorkerMessageType;

	try {
		adapters = await loadAdaptersFromDescriptors(data.descriptors);
		message = await performBuild(data, adapters);
	} finally {
		disposeAdapters(adapters);
	}

	parentPort?.postMessage(message);
	return message;
};

/**
 * Runs one retained execution worker owning adapters and every write-side stage.
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
	let current: Readonly<{id: number; cancellationBuffer: SharedArrayBuffer}> | null = null;
	let closing = false;
	let finish: (() => void) | null = null;
	let currentDone: Promise<true> | null = null;

	const handle = async (request: BuildWorkerRequestType): Promise<void> => {
		if (closing) {
			return;
		}

		if (current !== null) {
			postResult(request.id, {ok: false, failure: buildFailureOf(new Error('Build worker is already handling a request'), 'worker')});
			return;
		}

		const state = {id: request.id, cancellationBuffer: request.cancellationBuffer};
		current = state;
		const {promise: done, resolve: resolveDone} = Promise.withResolvers<true>();
		currentDone = done;
		debug('build request start', {id: request.id, rootDir: request.config.rootDir, adapters: request.adapterIds});

		try {
			adapters ??= await adaptersPromise;
			postResult(
				request.id,
				await performBuild(request, adapters, (progress) => {
					postProgress(request.id, progress);
				}),
			);
		} catch (error) {
			postResult(request.id, {ok: false, failure: buildFailureOf(error, 'worker')});
		} finally {
			if (current === state) {
				current = null;
				currentDone = null;
			}

			resolveDone(true);
			debug('build request complete', {id: request.id});
		}
	};

	const initialize = async (request: BuildWorkerInitializeRequestType): Promise<void> => {
		try {
			adapters ??= await adaptersPromise;
			initializeStorage(request, adapters);
		} catch (error) {
			const result: BuildWorkerInitializeResultType = {
				kind: 'code-index-initialize-result',
				id: request.id,
				ok: false,
				failure: buildFailureOf(error, 'persistence'),
			};
			parentPort?.postMessage(result);
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
			Atomics.store(new Int32Array(active.cancellationBuffer), 0, 1);
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

		if (isBuildWorkerRequest(value)) {
			void handle(value);
			return;
		}

		if (isInitializeRequest(value)) {
			void initialize(value);
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
