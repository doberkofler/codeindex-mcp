import {randomUUID} from 'node:crypto';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type ConfigType} from '../config/config.ts';
import {type AdapterSetType} from '../../adapters/loader.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {BUILD_LEASE_TTL_MS, type IndexDatabase} from '../storage/database.ts';
import {startBuildLeaseHeartbeat} from './buildLeaseHeartbeat.ts';
import {buildFailureOf, buildProjectContextOfScan} from './buildFailure.ts';
import {buildGeneration} from './buildGeneration.ts';
import {recordFailedRefresh, recordRefreshOutcome} from './refreshTelemetry.ts';
import {adapterSetOf, type CodeIndexOptionsType} from './codeIndexOptions.ts';
import {buildQueryContext} from './codeIndexQueryContext.ts';
import {type PersistentBuildWorker} from './persistentBuildWorker.ts';
import {buildWorkerOf} from './buildWorkerSetup.ts';
import {adapterTargets, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {adapterIgnoredSegments, adapterTargetsForScope, adapterWatchInputs, planAdapterScans, watchRoutesOf} from './adapterRefresh.ts';
import {
	findDependencies as queryDependencies,
	findReferences as queryReferences,
	findSymbols as querySymbols,
	type QueryContextType,
} from '../query/queryService.ts';
import {CodeIndexError, IndexNotReadyError} from '../errors/errors.ts';
import {acquireOrObserveBuildLease, externalBuildReport} from './externalBuild.ts';
import {readIndexStatus} from './codeIndexStatus.ts';
import {
	type BuildReportType,
	type ExactNamePresenceType,
	type FindDependenciesInputType,
	type FindDependenciesResultType,
	type FindReferencesInputType,
	type FindReferencesOccurrencesResultType,
	type FindReferencesResultType,
	type QueryFindReferencesInputType,
	type QueryFindReferencesResultType,
	type SymbolIdFindReferencesInputType,
	type SymbolIdGroupedFindReferencesInputType,
	type SymbolIdGroupedFindReferencesResultType,
	type FindSymbolInputType,
	type FindSymbolResultType,
	type GenerationRowType,
	type IndexStatusType,
	type IndexVerificationType,
	type OutlineInputType,
	type OutlineResultType,
	type QueryFreshnessType,
	type ReadSymbolInputType,
	type ReadSymbolResultType,
	type SymbolAtInputType,
	type SymbolAtResultType,
} from '../model.ts';
import {startProcessSample} from '../resources/processSample.ts';
import {queryOutline} from '../query/outlineQuery.ts';
import {verifyPublishedIndex} from './verifyIndex.ts';
import {queryReadSymbol} from '../query/readSymbolQuery.ts';
import {selectReadSymbol} from '../query/readSymbolSelection.ts';
import {querySymbolAt} from '../query/symbolAtQuery.ts';
import {RefreshCoordinator} from '../freshness/refreshCoordinator.ts';
import {WorkspaceWatcher} from '../freshness/workspaceWatcher.ts';

const debug = debugFor('index');
const LEASE_RENEW_MS = 3000;

export type {CodeIndexOptionsType} from './codeIndexOptions.ts';

/** Deep module owning indexing, freshness, persistence, and bounded queries. */
export class CodeIndex {
	readonly #config: ConfigType;
	readonly #adapterSet: AdapterSetType;
	readonly #targets: readonly AdapterTargetType[];
	readonly #database: IndexDatabase;
	readonly #logger: LoggerType;
	readonly #analytics: AnalyticsRecorderType | null;
	readonly #workerEntry: string | null;
	readonly #buildWorker: PersistentBuildWorker | null;
	readonly #watchEnabled: boolean;
	readonly #coordinator: RefreshCoordinator;
	readonly #watcher: WorkspaceWatcher;
	readonly #override: AdapterTargetType['extractor'] | undefined;
	readonly #ownerId = randomUUID();
	readonly #compilerDriftObserved = new Set<string>();
	/** Per-adapter non-source inputs discovered by the latest scan. */
	#watchInputs: ReadonlyMap<string, readonly string[]> = new Map();
	readonly #recordExactName = (presence: ExactNamePresenceType): void => {
		this.#analytics?.record('find_symbol_outcome', {presence});
	};
	#published: GenerationRowType | null = null;
	#closed = false;
	public constructor(config: ConfigType, database: IndexDatabase, logger: LoggerType, options: CodeIndexOptionsType = {}) {
		const adapterSet = adapterSetOf(options);

		this.#config = config;
		this.#override = options.extractor;
		this.#adapterSet = adapterSet;
		this.#targets = adapterTargets(config, adapterSet, options.extractor);
		this.#database = database;
		this.#logger = logger;
		this.#analytics = options.analytics ?? null;
		this.#published = database.getPublishedGeneration();
		this.#watchEnabled = options.watch ?? true;
		const worker = buildWorkerOf(config, options, adapterSet);
		this.#workerEntry = worker.entry;
		this.#buildWorker = worker.worker;
		this.#coordinator = new RefreshCoordinator({
			logger,
			adapters: this.#targets.map((target) => ({
				id: target.adapter.id,
				debounceMs: options.debounceMs ?? config.freshnessAdapterDebounceMs?.[target.adapter.id] ?? config.freshnessDebounceMs,
			})),
			initiallyCurrent: this.#published !== null,
			...(options.clock === undefined ? {} : {clock: options.clock}),
			...(options.reconcileIntervalMs === undefined ? {} : {reconcileIntervalMs: options.reconcileIntervalMs}),
			failedAdapterId: (error): string | null => buildFailureOf(error).adapter,
			runRefresh: async (reason, adapterIds, force, signal): Promise<BuildReportType> => {
				try {
					return await this.#performRefresh(reason, force, adapterIds, signal);
				} catch (error) {
					debug('coordinated refresh failed', {message: error instanceof Error ? error.message : String(error)});
					throw error;
				}
			},
			record: (event, fields): void => {
				this.#analytics?.record(event, fields);
			},
		});
		this.#watcher = new WorkspaceWatcher({
			rootDir: config.rootDir,
			logger,
			ignoredSegments: adapterIgnoredSegments(this.#targets),
			routes: watchRoutesOf(this.#config, this.#targets, this.#database, this.#watchInputs),
			onChange: (paths, adapterIds): void => {
				this.#coordinator.request({kind: 'change', paths, adapterIds});
			},
		});
		debug('index created', {
			published: this.#published?.id ?? null,
			worker: this.#workerEntry,
			watch: this.#watchEnabled,
			adapters: this.#targets.map((target) => target.adapter.id),
		});
	}
	/**
	 * Starts watching and the initial background reconciliation.
	 *
	 * The MCP transport becomes available immediately. Queries serve the previous
	 * published generation while a rebuild runs.
	 */
	public start(): void {
		if (this.#closed) {
			return;
		}
		if (this.#watchEnabled) {
			this.#watcher.start(watchRoutesOf(this.#config, this.#targets, this.#database, this.#watchInputs));
		}
		debug('startup refresh requested');
		this.#coordinator.start();
	}
	/**
	 * Reuses or rebuilds the index so it matches the current working copy.
	 *
	 * @param options - `force` ignores an existing reusable generation.
	 * @returns The published, reused, or superseded generation report.
	 * @throws {@link Error} When scanning or building fails.
	 */
	public async ensureReady(options: Readonly<{force?: boolean}> = {}): Promise<BuildReportType> {
		try {
			return await this.#coordinator.request({kind: 'manual', force: options.force === true});
		} catch (error) {
			debug('manual refresh failed', {message: error instanceof Error ? error.message : String(error)});
			throw error;
		}
	}
	async #performRefresh(
		reason: 'startup' | 'change' | 'reconcile' | 'manual',
		force: boolean,
		adapterIds: readonly string[] | null,
		signal: AbortSignal,
	): Promise<BuildReportType> {
		debug('refresh start', {reason, force, adapters: adapterIds});
		const startedAt = performance.now();
		const startedAtEpoch = Date.now();
		const targets = adapterTargetsForScope(this.#targets, adapterIds);
		const leaseOutcome = await acquireOrObserveBuildLease({
			database: this.#database,
			previous: this.#published,
			startedAt,
			signal,
			tryAcquire: () => this.#database.tryAcquireBuildLease(this.#ownerId, process.pid, BUILD_LEASE_TTL_MS),
			record: (event, fields) => {
				this.#analytics?.record(event, fields);
			},
		});
		const externalReport = externalBuildReport(leaseOutcome, this.#database, startedAtEpoch);
		if (externalReport !== null) {
			this.#published = this.#database.getPublishedGeneration();
			return externalReport;
		}
		const stopHeartbeat = startBuildLeaseHeartbeat({
			renew: () => this.#database.renewBuildLease(this.#ownerId, BUILD_LEASE_TTL_MS),
			intervalMs: LEASE_RENEW_MS,
			onFailure: (failure, error): void => {
				debug('build lease renewal skipped', {failure, message: error instanceof Error ? error.message : null});
			},
		});
		const sample = startProcessSample();
		const resources = (): Readonly<Record<string, number>> => ({...sample.stop(), databaseBytes: this.#database.databaseSizeBytes()});
		let plans: readonly AdapterScanPlanType[] = [];
		try {
			const published = this.#database.getPublishedGeneration();
			this.#published = published;
			plans = await planAdapterScans({
				config: this.#config,
				targets,
				database: this.#database,
				published,
				logger: this.#logger,
				analytics: this.#analytics,
				observed: this.#compilerDriftObserved,
			});
			this.#watchInputs = adapterWatchInputs(plans, this.#watchInputs);
			const report = await this.#rebuild(plans, force, startedAtEpoch, signal);
			this.#watcher.update(watchRoutesOf(this.#config, this.#targets, this.#database, this.#watchInputs));
			this.#published = this.#database.getPublishedGeneration();
			const telemetry = {
				logger: this.#logger,
				analytics: this.#analytics,
				reason,
				durationMs: report.durationMs,
				resources: resources(),
			};
			debug('refresh complete', {generationId: report.generationId, outcome: report.outcome, durationMs: report.durationMs});
			recordRefreshOutcome({...telemetry, report});
			return report;
		} catch (error) {
			recordFailedRefresh({
				logger: this.#logger,
				analytics: this.#analytics,
				reason,
				durationMs: Math.round(performance.now() - startedAt),
				message: error instanceof Error ? error.message : String(error),
				failure: buildFailureOf(
					error,
					'scan',
					buildProjectContextOfScan(plans.find((plan) => plan.scan !== null)?.scan ?? null),
					plans.length === 1 ? (plans[0]?.adapterId ?? null) : null,
				),
				resources: resources(),
			});
			throw error;
		} finally {
			// `resources()` stops the sampler only when analytics records a build.
			// Stopping it here keeps a disabled-analytics process from polling RSS
			// every 25 ms for the rest of its life.
			sample.stop();
			stopHeartbeat();
			try {
				this.#database.releaseBuildLease(this.#ownerId);
			} catch (error) {
				debug('build lease release failed', {message: error instanceof Error ? error.message : String(error)});
			}
		}
	}
	public getStatus(): IndexStatusType {
		const {status, published} = readIndexStatus({
			config: this.#config,
			adapters: this.#adapterSet.byId,
			database: this.#database,
			refresh: this.#coordinator.getSnapshot(),
		});
		this.#published = published;
		return status;
	}
	public getFreshness(): QueryFreshnessType {
		return this.#coordinator.getFreshness();
	}
	/**
	 * Checks the published generation's SQLite integrity and stored counts.
	 *
	 * @returns Integrity status and persisted row counts.
	 * @throws {@link IndexNotReadyError} When no generation is published.
	 * @throws {@link Error} When SQLite reports an integrity, foreign-key, or count problem.
	 */
	public verify(): IndexVerificationType {
		return this.#database.readSnapshot(() => verifyPublishedIndex(this.#database, this.#generation()));
	}
	public getOutline(input: OutlineInputType, maxResultBytes = this.#config.maxResultBytes): OutlineResultType {
		return this.#database.readSnapshot(() => {
			const generation = this.#generation();
			const owner = input.adapter ?? this.#database.fileAdapter(generation.id, input.path) ?? undefined;
			return queryOutline({
				database: this.#database,
				generationId: generation.id,
				generationRevision: generation.revision,
				freshness: this.#freshnessFor(owner),
				adapters: this.#targets.map((target) => target.adapter.id),
				input,
				maxResultBytes,
			});
		});
	}
	/**
	 * Finds the innermost stored definition covering one source position.
	 *
	 * @param input - Path, line, and optional column.
	 * @param maxResultBytes - Maximum serialized result-data size.
	 * @returns Candidate definitions, ambiguity, and lexical ancestors.
	 * @throws {@link CodeIndexError} When the path is invalid or not indexed.
	 */
	public symbolAt(input: SymbolAtInputType, maxResultBytes = this.#config.maxResultBytes): SymbolAtResultType {
		return this.#database.readSnapshot(() => {
			const generation = this.#generation();
			const owner = input.adapter ?? this.#database.fileAdapter(generation.id, input.path) ?? undefined;
			return querySymbolAt({
				database: this.#database,
				generationId: generation.id,
				freshness: this.#freshnessFor(owner),
				adapters: this.#targets.map((target) => target.adapter.id),
				selector: input,
				maxResultBytes,
			});
		});
	}
	/**
	 * Finds declarations by exact or prefix name.
	 *
	 * @param input - Query text and page bounds.
	 * @param maxResultBytes - Maximum serialized result-data size.
	 * @returns Paginated symbol matches with explicit freshness.
	 */
	public findSymbols(input: FindSymbolInputType, maxResultBytes = this.#config.maxResultBytes): FindSymbolResultType {
		return this.#database.readSnapshot(() => {
			const generation = this.#generation();
			return querySymbols(this.#queryContext(input.adapter, generation), input, maxResultBytes);
		});
	}
	/** Finds occurrences for one symbol identifier or resolves one symbol query in the same call. */
	public findReferences(input: SymbolIdFindReferencesInputType, maxResultBytes?: number): FindReferencesOccurrencesResultType;
	public findReferences(input: SymbolIdGroupedFindReferencesInputType, maxResultBytes?: number): SymbolIdGroupedFindReferencesResultType;
	public findReferences(input: QueryFindReferencesInputType, maxResultBytes?: number): QueryFindReferencesResultType;
	public findReferences(input: FindReferencesInputType, maxResultBytes?: number): FindReferencesResultType;
	public findReferences(input: FindReferencesInputType, maxResultBytes = this.#config.maxResultBytes): FindReferencesResultType {
		return this.#database.readSnapshot(() => {
			const generation = this.#generation();
			const owner =
				input.adapter ?? (input.symbolId === undefined ? undefined : (this.#database.getSymbol(generation.id, input.symbolId)?.adapter ?? undefined));
			return queryReferences(this.#queryContext(owner, generation), input, maxResultBytes);
		});
	}
	/**
	 * Finds authored modules that consume one normalized npm package.
	 *
	 * Direct usage returns modules with a target edge. Dependency impact traverses
	 * authored imports, keeps the direct consumer that starts every shortest
	 * path, and groups results by that root. Compact results omit locations and bindings unless evidence is requested.
	 *
	 * @param input - Package name, traversal mode, optional root, detail level, and page bounds.
	 * @param maxResultBytes - Maximum serialized result-data size.
	 * @returns Paginated dependency consumers with complete-set counts.
	 */
	public findDependencies(input: FindDependenciesInputType, maxResultBytes = this.#config.maxResultBytes): FindDependenciesResultType {
		return this.#database.readSnapshot(() => {
			const generation = this.#generation();
			return queryDependencies(this.#queryContext(input.adapter, generation), input, maxResultBytes);
		});
	}
	/**
	 * Reads bounded source for one indexed symbol identifier or natural query.
	 *
	 * @param input - Symbol selector, optional filters, mode, and bounds.
	 * @param maxResultBytes - Maximum serialized result-data size, excluding envelope framing.
	 * @returns Source and freshness for the symbol.
	 * @throws {@link CodeIndexError} When the symbol or its file is not indexed.
	 * @throws {@link StaleFileError} When the source changed or is still pending a rebuild.
	 */
	public readSymbol(input: ReadSymbolInputType, maxResultBytes = this.#config.maxResultBytes): ReadSymbolResultType {
		return this.#database.readSnapshot(() => {
			const generation = this.#generation();
			const freshness = this.#freshnessFor(input.adapter);
			const selection = selectReadSymbol(
				{
					...this.#queryContext(input.adapter, generation),
					generationId: generation.id,
					freshness,
					maxResultBytes,
				},
				input,
			);
			if ('result' in selection) {
				return selection.result;
			}
			const symbol = this.#database.getSymbol(generation.id, selection.symbolId);
			if (symbol === null) {
				throw new CodeIndexError(
					'symbol_not_found',
					`Unknown symbol: ${selection.symbolId}. Symbol IDs are opaque; copy one from find_symbol or outline instead of constructing it.`,
				);
			}
			const ownerFreshness = this.#freshnessFor(symbol.adapter);
			return queryReadSymbol(
				{
					database: this.#database,
					rootDir: this.#config.rootDir,
					generationId: generation.id,
					generationRevision: generation.revision,
					freshness: ownerFreshness,
					symbol,
					...(selection.adapter === undefined ? {} : {adapter: selection.adapter}),
					isPathDirty: (pathName) => this.#coordinator.isPathDirty(pathName, symbol.adapter),
					maxReadLines: this.#config.maxReadLines,
					maxResultBytes,
				},
				input,
			);
		});
	}
	public async close(): Promise<void> {
		debug('close');
		this.#closed = true;
		// Close scheduling before terminating the worker so a worker rejection
		// cannot enqueue a retry during shutdown. Worker termination still unpins
		// coordinator close when cancellation is inside synchronous adapter work.
		const coordinatorClose = this.#coordinator.close();
		await this.#buildWorker?.close();
		await coordinatorClose;
		this.#watcher.close();
		for (const adapter of this.#adapterSet.adapters) {
			adapter.dispose?.();
		}
		this.#database.releaseBuildLease(this.#ownerId);
		this.#analytics?.close();
		this.#database.close();
	}
	#freshnessFor(adapterId?: string): QueryFreshnessType {
		return this.#coordinator.getFreshness(adapterId === undefined ? null : [adapterId]);
	}
	#queryContext(adapterId: string | undefined, generation: GenerationRowType): QueryContextType {
		return buildQueryContext({
			database: this.#database,
			generationId: generation.id,
			generationRevision: generation.revision,
			freshness: this.#freshnessFor(adapterId),
			targets: this.#targets,
			...(this.#analytics === null ? {} : {exactNameTelemetry: this.#recordExactName}),
		});
	}
	async #rebuild(plans: readonly AdapterScanPlanType[], force: boolean, startedAtEpoch: number, signal?: AbortSignal): Promise<BuildReportType> {
		const workerPath = this.#workerEntry;
		const buildWorker = this.#buildWorker;
		debug('rebuild requested', {force, worker: workerPath, adapters: plans.length});
		if (workerPath === null || buildWorker === null) {
			debug('building in process');
			return buildGeneration({
				config: this.#config,
				database: this.#database,
				logger: this.#logger,
				adapters: this.#adapterSet,
				scans: plans,
				force,
				ownerId: this.#ownerId,
				startedAtEpoch,
				...(this.#override === undefined ? {} : {extractor: this.#override}),
				...(signal === undefined ? {} : {isCancelled: () => signal.aborted}),
			});
		}
		const report = await buildWorker.run({
			config: this.#config,
			scans: plans,
			force,
			ownerId: this.#ownerId,
			startedAtEpoch,
			...(signal === undefined ? {} : {signal}),
		});
		return report;
	}
	#generation(): GenerationRowType {
		const published = this.#database.getPublishedGeneration();
		if (published === null) {
			throw new IndexNotReadyError();
		}
		this.#published = published;
		return published;
	}
}
export const createCodeIndex = (config: ConfigType, database: IndexDatabase, logger: LoggerType, options: CodeIndexOptionsType = {}): CodeIndex =>
	new CodeIndex(config, database, logger, options);
