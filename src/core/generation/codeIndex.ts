import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type ConfigType} from '../config/config.ts';
import {extractorFor} from '../../adapters/registry.ts';
import {extractorSourceExtensions, type ExtractorType} from '../../adapters/types.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {BUILD_LEASE_TTL_MS, type IndexDatabase} from '../storage/database.ts';
import {startBuildLeaseHeartbeat} from './buildLeaseHeartbeat.ts';
import {buildFailureCauseOf} from './buildFailureCause.ts';
import {buildGeneration} from './buildGeneration.ts';
import {type CodeIndexOptionsType} from './codeIndexOptions.ts';
import {runBuildWorkerThread} from './buildWorkerClient.ts';
import {findDependencies as queryDependencies, findReferences as queryReferences, findSymbols as querySymbols} from '../query/queryService.ts';
import {CodeIndexError, IndexNotReadyError} from '../errors/errors.ts';
import {acquireOrObserveBuildLease, EXTERNAL_BUILD_TIMEOUT_MS} from './externalBuild.ts';
import {collectStatus} from '../freshness/indexStatus.ts';
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
	type ScanResultType,
	type SymbolAtInputType,
	type SymbolAtResultType,
} from '../model.ts';
import {publishedFiles} from './publishedFiles.ts';
import {startProcessSample} from '../resources/processSample.ts';
import {queryOutline} from '../query/outlineQuery.ts';
import {verifyPublishedIndex} from './verifyIndex.ts';
import {queryReadSymbol} from '../query/readSymbolQuery.ts';
import {selectReadSymbol} from '../query/readSymbolSelection.ts';
import {querySymbolAt} from '../query/symbolAtQuery.ts';
import {RefreshCoordinator, type RefreshReasonType} from '../freshness/refreshCoordinator.ts';
import {WorkspaceWatcher} from '../freshness/workspaceWatcher.ts';

const debug = debugFor('index');
const LEASE_RENEW_MS = 3000;

export type {CodeIndexOptionsType} from './codeIndexOptions.ts';

/** Deep module owning indexing, freshness, persistence, and bounded queries. */
export class CodeIndex {
	readonly #config: ConfigType;
	readonly #extractor: ExtractorType;
	readonly #database: IndexDatabase;
	readonly #logger: LoggerType;
	readonly #analytics: AnalyticsRecorderType | null;
	readonly #workerEntry: string | null;
	readonly #watchEnabled: boolean;
	readonly #coordinator: RefreshCoordinator;
	readonly #watcher: WorkspaceWatcher;
	readonly #ownerId = randomUUID();
	#published: GenerationRowType | null = null;
	#refreshing: Promise<BuildReportType> | null = null;
	#closed = false;

	public constructor(config: ConfigType, database: IndexDatabase, logger: LoggerType, options: CodeIndexOptionsType = {}) {
		this.#config = config;
		this.#extractor = options.extractor ?? extractorFor(config.extractorId);
		this.#database = database;
		this.#logger = logger;
		this.#analytics = options.analytics ?? null;
		this.#published = database.getPublishedGeneration();
		this.#watchEnabled = options.watch ?? true;

		const workerPath = fileURLToPath(new URL('buildWorker.js', import.meta.url));
		this.#workerEntry = options.extractor === undefined ? (options.workerEntry ?? (existsSync(workerPath) ? workerPath : null)) : null;

		this.#coordinator = new RefreshCoordinator({
			logger,
			...(options.clock === undefined ? {} : {clock: options.clock}),
			...(options.debounceMs === undefined ? {} : {debounceMs: options.debounceMs}),
			...(options.reconcileIntervalMs === undefined ? {} : {reconcileIntervalMs: options.reconcileIntervalMs}),
			runRefresh: async (reason): Promise<void> => {
				await this.#refresh(reason, false);
			},
			record: (event, fields): void => {
				this.#analytics?.record(event, fields);
			},
		});
		this.#watcher = new WorkspaceWatcher({
			rootDir: config.rootDir,
			logger,
			sourceExtensions: extractorSourceExtensions(this.#extractor, config),
			ignoredSegments: this.#extractor.ignoredSegments,
			onChange: (paths): void => {
				this.#coordinator.notify(paths);
			},
		});

		if (this.#published !== null) {
			this.#coordinator.markCurrent();
		}

		debug('index created', {published: this.#published?.id ?? null, worker: this.#workerEntry, watch: this.#watchEnabled});
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
			this.#watcher.start(publishedFiles(this.#database, this.#config.rootDir), this.#extractor.configFiles(this.#config));
		}

		debug('startup refresh requested');
		this.#coordinator.notify([]);
		this.#coordinator.start();
	}

	/**
	 * Reuses or rebuilds the index so it matches the current working copy.
	 *
	 * @param options - `force` ignores an existing reusable generation.
	 * @returns The published generation's build report.
	 * @throws {@link Error} When scanning or building fails.
	 */
	public async ensureReady(options: Readonly<{force?: boolean}> = {}): Promise<BuildReportType> {
		const report = await this.#refresh('manual', options.force === true);
		this.#coordinator.markCurrent();
		return report;
	}

	async #refresh(reason: RefreshReasonType, force: boolean): Promise<BuildReportType> {
		if (this.#refreshing !== null) {
			debug('refresh already in progress', {reason});
			return this.#refreshing;
		}

		const refreshing = this.#performRefresh(reason, force);
		this.#refreshing = refreshing;

		try {
			return await refreshing;
		} finally {
			if (this.#refreshing === refreshing) {
				this.#refreshing = null;
			}
		}
	}

	async #performRefresh(reason: RefreshReasonType, force: boolean): Promise<BuildReportType> {
		debug('refresh start', {reason, force});
		const startedAt = performance.now();
		const leaseOutcome = await acquireOrObserveBuildLease({
			database: this.#database,
			previous: this.#published,
			startedAt,
			deadlineAt: Date.now() + EXTERNAL_BUILD_TIMEOUT_MS,
			tryAcquire: () => this.#database.tryAcquireBuildLease(this.#ownerId, process.pid, BUILD_LEASE_TTL_MS),
			record: (event, fields) => {
				this.#analytics?.record(event, fields);
			},
		});
		if (leaseOutcome.state === 'published') {
			return leaseOutcome.report;
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
		try {
			const published = this.#database.getPublishedGeneration();
			this.#published = published;
			const knownPaths = published === null ? [] : this.#database.listFiles(published.id).map((file) => file.path);
			const scan = this.#extractor.scan(this.#config, knownPaths);

			if (scan.compilerDrift) {
				this.#logger.warn('compiler_drift', {extractorCompiler: scan.compilerVersion, declaredCompiler: scan.declaredCompilerVersion});
				this.#analytics?.record('compiler_drift', {
					extractorVersion: scan.compilerVersion,
					declaredVersion: scan.declaredCompilerVersion,
				});
			}
			const report = await this.#rebuild(scan, force);

			if (this.#watchEnabled) {
				this.#watcher.update(scan.files, this.#extractor.configFiles(this.#config), extractorSourceExtensions(this.#extractor, this.#config));
			}

			this.#published = this.#database.getPublishedGeneration();
			debug('refresh complete', {generationId: report.generationId, reused: report.reused, durationMs: report.durationMs});
			this.#logger.info('index_ready', {
				generationId: report.generationId,
				reused: report.reused,
				durationMs: report.durationMs,
				files: report.fileCount,
				symbols: report.symbolCount,
				occurrences: report.occurrenceCount,
			});
			this.#analytics?.record(report.reused ? 'build_reused' : 'build_complete', {
				reason,
				durationMs: report.durationMs,
				fileCount: report.fileCount,
				symbolCount: report.symbolCount,
				occurrenceCount: report.occurrenceCount,
				stages: report.stages,
				...resources(),
			});
			return report;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const cause = buildFailureCauseOf(error);
			debug('refresh failed', {message, cause});
			this.#logger.error('index_refresh_failed', {message, cause});
			this.#analytics?.record('build_failed', {
				reason,
				cause,
				durationMs: Math.round(performance.now() - startedAt),
				...resources(),
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
		return this.#database.readSnapshot(() => {
			const published = this.#database.getPublishedGeneration();
			this.#published = published;
			const status = collectStatus({
				config: this.#config,
				database: this.#database,
				published,
				refresh: this.#coordinator.getSnapshot(),
				workingCopyId: this.#database.getWorkingCopy()?.id ?? null,
				lastError: null,
			});
			debug('status', {state: status.state, refresh: status.refresh, published: published?.id ?? null, dirtyFiles: status.freshness.dirtyFileCount});

			return status;
		});
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
		return this.#database.readSnapshot(() => this.#verifySnapshot());
	}

	#verifySnapshot(): IndexVerificationType {
		return verifyPublishedIndex(this.#database, this.#generation());
	}

	public getOutline(input: OutlineInputType, maxResultBytes = this.#config.maxResultBytes): OutlineResultType {
		return this.#database.readSnapshot(() => {
			const generation = this.#generation();

			return queryOutline({
				database: this.#database,
				generationId: generation.id,
				freshness: this.getFreshness(),
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

			return querySymbolAt({
				database: this.#database,
				generationId: generation.id,
				freshness: this.getFreshness(),
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
			const context = {
				database: this.#database,
				generationId: this.#generation().id,
				freshness: this.getFreshness(),
				...(this.#analytics === null
					? {}
					: {
							exactNameTelemetry: (presence: ExactNamePresenceType): void => {
								this.#analytics?.record('find_symbol_outcome', {presence});
							},
						}),
			};

			return querySymbols(context, input, maxResultBytes);
		});
	}

	/** Finds occurrences for one symbol identifier or resolves one symbol query in the same call. */
	public findReferences(input: SymbolIdFindReferencesInputType, maxResultBytes?: number): FindReferencesOccurrencesResultType;
	public findReferences(input: SymbolIdGroupedFindReferencesInputType, maxResultBytes?: number): SymbolIdGroupedFindReferencesResultType;
	public findReferences(input: QueryFindReferencesInputType, maxResultBytes?: number): QueryFindReferencesResultType;
	public findReferences(input: FindReferencesInputType, maxResultBytes?: number): FindReferencesResultType;
	public findReferences(input: FindReferencesInputType, maxResultBytes = this.#config.maxResultBytes): FindReferencesResultType {
		return this.#database.readSnapshot(() => {
			const context = {database: this.#database, generationId: this.#generation().id, freshness: this.getFreshness()};
			return queryReferences(context, input, maxResultBytes);
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
			const context = {database: this.#database, generationId: this.#generation().id, freshness: this.getFreshness()};
			return queryDependencies(context, input, maxResultBytes);
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
			const freshness = this.getFreshness();
			const selection = selectReadSymbol({database: this.#database, generationId: generation.id, freshness, maxResultBytes}, input);

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

			return queryReadSymbol(
				{
					database: this.#database,
					rootDir: this.#config.rootDir,
					generationId: generation.id,
					freshness,
					symbol,
					isPathDirty: (pathName) => this.#coordinator.isPathDirty(pathName),
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
		await this.#coordinator.close();
		this.#watcher.close();

		if (this.#refreshing !== null) {
			try {
				await this.#refreshing;
			} catch {
				// The refresh failure is already recorded on the index.
			}
		}

		this.#database.releaseBuildLease(this.#ownerId);
		this.#analytics?.close();
		this.#database.close();
	}
	async #rebuild(scan: ScanResultType, force: boolean): Promise<BuildReportType> {
		const workerPath = this.#workerEntry;
		debug('rebuild requested', {force, worker: workerPath, files: scan.files.length});

		if (workerPath === null) {
			debug('building in process');
			return buildGeneration({
				config: this.#config,
				database: this.#database,
				logger: this.#logger,
				scan,
				force,
				ownerId: this.#ownerId,
				extractor: this.#extractor,
			});
		}

		const report = await runBuildWorkerThread({
			workerEntry: workerPath,
			config: this.#config,
			scan,
			force,
			ownerId: this.#ownerId,
			debug: debug.enabled,
		});

		return report;
	}
	#generation(): GenerationRowType {
		const published = this.#database.getPublishedGeneration();

		if (published === null) {
			debug('no published generation');
			throw new IndexNotReadyError();
		}

		this.#published = published;
		return published;
	}
}
export const createCodeIndex = (config: ConfigType, database: IndexDatabase, logger: LoggerType, options: CodeIndexOptionsType = {}): CodeIndex =>
	new CodeIndex(config, database, logger, options);
