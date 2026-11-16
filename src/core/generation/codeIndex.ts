import {randomUUID} from 'node:crypto';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type ConfigType} from '../config/config.ts';
import {type AdapterSetType} from '../../adapters/loader.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {buildFailureOf} from './buildFailure.ts';
import {recordFailedRefresh, recordRefreshOutcome} from './refreshTelemetry.ts';
import {adapterSetOf, manualAdapterScope, type CodeIndexOptionsType, type ManualRefreshOptionsType} from './codeIndexOptions.ts';
import {buildQueryContext} from './codeIndexQueryContext.ts';
import {type PersistentBuildWorker} from './persistentBuildWorker.ts';
import {buildWorkerOf} from './buildWorkerSetup.ts';
import {adapterTargets, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {mergeAdapterWatchPlans, createAdapterWatchPlans, watchPlansMatchTargets} from './adapterWatchPlans.ts';
import {
	findDependencies as queryDependencies,
	findReferences as queryReferences,
	findSymbols as querySymbols,
	type QueryContextType,
} from '../query/queryService.ts';
import {CodeIndexError, IndexNotReadyError} from '../errors/errors.ts';
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
import {startEventLoopSample} from '../resources/eventLoopSample.ts';
import {recordCompilerDrift} from './compilerDriftTelemetry.ts';
import {queryOutline} from '../query/outlineQuery.ts';
import {verifyPublishedIndex} from './verifyIndex.ts';
import {queryReadSymbol} from '../query/readSymbolQuery.ts';
import {selectReadSymbol} from '../query/readSymbolSelection.ts';
import {querySymbolAt} from '../query/symbolAtQuery.ts';
import {RefreshCoordinator} from '../freshness/refreshCoordinator.ts';
import {AdapterWatchController} from '../freshness/adapterWatchController.ts';
import {runInProcessRefresh} from './inProcessRefresh.ts';
import {buildGeneration} from './buildGeneration.ts';
import {BuildActivity} from './buildActivity.ts';

const debug = debugFor('index');

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
	readonly #coordinator: RefreshCoordinator;
	readonly #watchController: AdapterWatchController;
	readonly #override: AdapterTargetType['extractor'] | undefined;
	readonly #ownerId = randomUUID();
	readonly #compilerDriftObserved = new Set<string>();
	readonly #recordExactName = (presence: ExactNamePresenceType): void => {
		this.#analytics?.record('find_symbol_outcome', {presence});
	};
	#published: GenerationRowType | null = null;
	readonly #activity = new BuildActivity();
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
		const watchEnabled = options.watch ?? true;
		const worker = buildWorkerOf(config, options, adapterSet);
		this.#workerEntry = worker.entry;
		this.#buildWorker = worker.worker;
		const restoredWatchPlans = database.getWatchPlans();
		const watchPlans = watchPlansMatchTargets(restoredWatchPlans, this.#targets)
			? restoredWatchPlans
			: createAdapterWatchPlans(this.#config, this.#targets, null);

		if (!watchPlansMatchTargets(restoredWatchPlans, this.#targets) && this.#buildWorker === null) {
			database.putWatchPlans(watchPlans);
		}
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
		this.#watchController = new AdapterWatchController({
			enabled: watchEnabled,
			rootDir: config.rootDir,
			logger,
			plans: watchPlans,
			onChange: (paths, adapterIds): void => {
				this.#coordinator.request({kind: 'change', paths, adapterIds});
			},
			onHandoff: (): void => {
				this.#coordinator.request({kind: 'reconcile'});
			},
		});
		debug('index created', {
			published: this.#published?.id ?? null,
			worker: this.#workerEntry,
			watch: watchEnabled,
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
		this.#watchController.start();
		debug('startup refresh requested');
		this.#coordinator.start();
	}
	/**
	 * @param options - Force flag and optional adapter scope.
	 * @returns The published, reused, or superseded generation report.
	 */
	public async ensureReady(options: ManualRefreshOptionsType = {}): Promise<BuildReportType> {
		const adapterIds = manualAdapterScope(options, this.#adapterSet, (adapterId) => {
			throw new CodeIndexError('unknown_adapter', `Unknown adapter: ${adapterId}`);
		});

		try {
			return await this.#coordinator.request({kind: 'manual', force: options.force === true, adapterIds});
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
		const report = await this.#activity.run({reason, force, adapterIds}, async () => {
			if (this.#buildWorker !== null) {
				const workerReport = await this.#performWorkerRefresh(reason, force, adapterIds, signal);
				return workerReport;
			}

			const inProcessReport = await this.#performInProcessRefresh(reason, force, adapterIds, signal);
			return inProcessReport;
		});
		return report;
	}
	async #performWorkerRefresh(
		reason: 'startup' | 'change' | 'reconcile' | 'manual',
		force: boolean,
		adapterIds: readonly string[] | null,
		signal: AbortSignal,
	): Promise<BuildReportType> {
		debug('refresh start', {reason, force, adapters: adapterIds});
		const startedAt = performance.now();
		const startedAtEpoch = Date.now();
		const responsiveness = startEventLoopSample();
		const buildWorker = this.#buildWorker;

		if (buildWorker === null) {
			throw new Error('Build worker is unavailable');
		}

		try {
			const result = await buildWorker.run({
				config: this.#config,
				adapterIds,
				force,
				ownerId: this.#ownerId,
				startedAtEpoch,
				signal,
				onProgress: this.#activity.update,
			});

			for (const drift of result.compilerDrifts) {
				recordCompilerDrift({
					logger: this.#logger,
					analytics: this.#analytics,
					observed: this.#compilerDriftObserved,
					scan: {...drift, compilerDrift: true},
				});
			}

			this.#watchController.update(result.watchPlans);
			this.#published = this.#database.getPublishedGeneration();
			const resources = {...result.resources, ...responsiveness.stop()};
			recordRefreshOutcome({
				logger: this.#logger,
				analytics: this.#analytics,
				reason,
				durationMs: result.report.durationMs,
				resources,
				report: result.report,
			});
			debug('refresh complete', {
				generationId: result.report.generationId,
				outcome: result.report.outcome,
				durationMs: result.report.durationMs,
			});
			return result.report;
		} catch (error) {
			recordFailedRefresh({
				logger: this.#logger,
				analytics: this.#analytics,
				reason,
				durationMs: Math.round(performance.now() - startedAt),
				message: error instanceof Error ? error.message : String(error),
				failure: buildFailureOf(error, 'worker'),
				resources: responsiveness.stop(),
			});
			throw error;
		} finally {
			responsiveness.stop();
		}
	}
	async #performInProcessRefresh(
		reason: 'startup' | 'change' | 'reconcile' | 'manual',
		force: boolean,
		adapterIds: readonly string[] | null,
		signal: AbortSignal,
	): Promise<BuildReportType> {
		debug('in-process refresh start', {reason, force, adapters: adapterIds});
		const result = await runInProcessRefresh({
			reason,
			force,
			adapterIds,
			signal,
			config: this.#config,
			database: this.#database,
			logger: this.#logger,
			analytics: this.#analytics,
			ownerId: this.#ownerId,
			targets: this.#targets,
			compilerDriftObserved: this.#compilerDriftObserved,
			onProgress: this.#activity.update,
			build: async (plans: readonly AdapterScanPlanType[], startedAtEpoch: number) => {
				const report = await buildGeneration({
					config: this.#config,
					database: this.#database,
					logger: this.#logger,
					adapters: this.#adapterSet,
					scans: plans,
					force,
					ownerId: this.#ownerId,
					startedAtEpoch,
					...(this.#override === undefined ? {} : {extractor: this.#override}),
					isCancelled: () => signal.aborted,
					onProgress: this.#activity.update,
				});
				return report;
			},
		});
		if (result.report.outcome !== 'superseded') {
			const updates = createAdapterWatchPlans(this.#config, this.#targets, result.plans);
			const plans = mergeAdapterWatchPlans(this.#watchController.plans, updates, this.#targets);
			this.#database.putWatchPlans(plans);
			this.#watchController.update(plans);
		}
		this.#published = this.#database.getPublishedGeneration();
		return result.report;
	}
	public getStatus(): IndexStatusType {
		const {status, published} = readIndexStatus({
			config: this.#config,
			adapters: this.#adapterSet.byId,
			database: this.#database,
			refresh: this.#coordinator.getSnapshot(),
			activity: this.#activity.current,
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
	/** Reads bounded source for one indexed symbol identifier or natural query.
	 * @param input - Symbol selector, optional filters, mode, and bounds.
	 * @param maxResultBytes - Maximum serialized result-data size.
	 * @returns Source and freshness for the symbol.
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
		// Stop scheduling first so worker rejection cannot enqueue a shutdown retry.
		const coordinatorClose = this.#coordinator.close();
		await this.#buildWorker?.close();
		await coordinatorClose;
		this.#watchController.close();
		for (const adapter of this.#adapterSet.adapters) {
			adapter.dispose?.();
		}
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
