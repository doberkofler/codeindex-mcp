import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type ConfigType} from '../config/config.ts';
import {extractorFor} from '../../adapters/registry.ts';
import {type ExtractorType} from '../../adapters/types.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {buildGeneration} from './buildGeneration.ts';
import {runBuildWorkerThread} from './buildWorkerClient.ts';
import {findDependencies as queryDependencies, findReferences as queryReferences, findSymbols as querySymbols} from '../query/queryService.ts';
import {CodeIndexError, IndexNotReadyError, StaleFileError} from '../errors/errors.ts';
import {observeExternalBuild} from './externalBuild.ts';
import {collectStatus} from '../freshness/indexStatus.ts';
import {
	type BuildReportType,
	type FindDependenciesInputType,
	type FindDependenciesResultType,
	type FindReferencesInputType,
	type FindReferencesResultType,
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
} from '../model.ts';
import {boundedPagedResult, decodeCursor, normalizeRelativePath} from '../query/querySupport.ts';
import {publishedFiles} from './publishedFiles.ts';
import {readSymbolSource} from '../query/readSymbolSource.ts';
import {hashContent} from './sourceFiles.ts';
import {type ClockType, RefreshCoordinator, type RefreshReasonType} from '../freshness/refreshCoordinator.ts';
import {WorkspaceWatcher} from '../freshness/workspaceWatcher.ts';

const {sep} = path;
const debug = debugFor('index');
const LEASE_TTL_MS = 10_000;
const LEASE_RENEW_MS = 3000;

export type CodeIndexOptionsType = Readonly<{
	readonly workerEntry?: string;
	readonly clock?: ClockType;
	readonly watch?: boolean;
	readonly debounceMs?: number;
	readonly reconcileIntervalMs?: number;
	readonly analytics?: AnalyticsRecorderType;
}>;

/**
 * Deep module owning indexing, freshness, persistence, and bounded queries.
 *
 * MCP is a translation adapter over this interface. Tests exercise the same
 * interface with fixture workspaces and temporary databases.
 */
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
		this.#extractor = extractorFor(config.extractorId);
		this.#database = database;
		this.#logger = logger;
		this.#analytics = options.analytics ?? null;
		this.#published = database.getPublishedGeneration();
		this.#watchEnabled = options.watch ?? true;

		const workerPath = fileURLToPath(new URL('buildWorker.js', import.meta.url));
		this.#workerEntry = options.workerEntry ?? (existsSync(workerPath) ? workerPath : null);

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
			sourceExtensions: this.#extractor.sourceExtensions,
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
		if (this.#refreshing !== null) {
			debug('refresh already in progress');
			return this.#refreshing;
		}

		this.#refreshing = this.#refresh('manual', options.force === true);

		try {
			const report = await this.#refreshing;
			this.#coordinator.markCurrent();
			return report;
		} finally {
			this.#refreshing = null;
		}
	}

	async #refresh(reason: RefreshReasonType, force: boolean): Promise<BuildReportType> {
		debug('refresh start', {reason, force});
		const startedAt = performance.now();
		const leaseAcquired = this.#database.tryAcquireBuildLease(this.#ownerId, process.pid, LEASE_TTL_MS);

		if (!leaseAcquired) {
			debug('build lease held by another process');
			return observeExternalBuild({
				database: this.#database,
				previous: this.#published,
				startedAt,
				record: (event, fields) => {
					this.#analytics?.record(event, fields);
				},
			});
		}

		const heartbeat = setInterval(() => {
			if (!this.#database.renewBuildLease(this.#ownerId, LEASE_TTL_MS)) {
				debug('build lease renewal failed');
			}
		}, LEASE_RENEW_MS);
		heartbeat.unref();

		try {
			const published = this.#database.getPublishedGeneration();
			this.#published = published;
			const knownPaths = published === null ? [] : this.#database.listFiles(published.id).map((file) => file.path);
			const scan = this.#extractor.scan(this.#config, knownPaths);

			if (scan.compilerDrift) {
				this.#logger.warn('compiler_drift', {
					extractorCompiler: scan.compilerVersion,
					declaredCompiler: scan.declaredCompilerVersion,
				});
				this.#analytics?.record('compiler_drift', {
					extractorVersion: scan.compilerVersion,
					declaredVersion: scan.declaredCompilerVersion,
				});
			}

			const report = await this.#rebuild(scan, force);

			if (this.#watchEnabled) {
				this.#watcher.update(scan.files, this.#extractor.configFiles(this.#config));
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
			});

			return report;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debug('refresh failed', {message});
			this.#logger.error('index_refresh_failed', {message});
			this.#analytics?.record('build_failed', {
				reason,
				durationMs: Math.round(performance.now() - startedAt),
			});
			throw error;
		} finally {
			clearInterval(heartbeat);
			this.#database.releaseBuildLease(this.#ownerId);
		}
	}

	public getStatus(): IndexStatusType {
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
		debug('status', {
			state: status.state,
			refresh: status.refresh,
			published: published?.id ?? null,
			dirtyFiles: status.freshness.dirtyFileCount,
		});

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
		const generation = this.#generation();
		this.#database.verifyIntegrity();

		const counts = {
			files: this.#database.countRows(generation.id, 'file'),
			symbols: this.#database.countRows(generation.id, 'symbol'),
			occurrences: this.#database.countRows(generation.id, 'occurrence'),
			dependencyEdges: this.#database.countRows(generation.id, 'dependency_edge'),
			dependencyBindings: this.#database.countRows(generation.id, 'dependency_binding'),
			diagnostics: this.#database.countRows(generation.id, 'diagnostic'),
		};
		const metadataMatches =
			counts.files === generation.fileCount &&
			counts.symbols === generation.symbolCount &&
			counts.occurrences === generation.occurrenceCount &&
			counts.dependencyEdges === generation.dependencyEdgeCount &&
			counts.dependencyBindings === generation.dependencyBindingCount &&
			counts.diagnostics === generation.diagnosticCount;

		if (!metadataMatches) {
			throw new Error(
				`Index metadata counts do not match stored rows: files ${counts.files}/${generation.fileCount}, symbols ${counts.symbols}/${generation.symbolCount}, occurrences ${counts.occurrences}/${generation.occurrenceCount}, dependency edges ${counts.dependencyEdges}/${generation.dependencyEdgeCount}, dependency bindings ${counts.dependencyBindings}/${generation.dependencyBindingCount}, diagnostics ${counts.diagnostics}/${generation.diagnosticCount}`,
			);
		}

		return {generationId: generation.id, integrity: 'ok', metadataMatches, counts};
	}

	public getOutline(input: OutlineInputType, maxResultBytes = this.#config.maxResultBytes): OutlineResultType {
		const generation = this.#generation();
		const freshness = this.getFreshness();
		const pathName = normalizeRelativePath(input.path);
		const offset = decodeCursor(input.cursor, generation.id, 'outline').o;
		const kinds = input.kinds ?? [];
		const rows = this.#database.listOutline({generationId: generation.id, path: pathName, kinds, limit: input.limit + 1, offset});
		debug('outline', {generationId: generation.id, path: pathName, kinds, limit: input.limit, offset, rows: rows.length});

		if (offset === 0 && rows.length === 0) {
			const file = this.#database.getFile(generation.id, pathName);

			if (file === null) {
				throw new CodeIndexError('file_not_indexed', `File is not in the published index: ${pathName}`);
			}
		}

		const items = rows.slice(0, input.limit);

		return boundedPagedResult({
			generationId: generation.id,
			items,
			offset,
			queryKind: 'outline',
			hasMore: rows.length > items.length,
			maxResultBytes,
			createResult: (page) => ({generationId: generation.id, freshness, ...page}),
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
		const context = {database: this.#database, generationId: this.#generation().id, freshness: this.getFreshness()};
		return querySymbols(context, input, maxResultBytes);
	}

	/**
	 * Finds stored occurrences for one symbol.
	 *
	 * @param input - Symbol, optional role, and page bounds.
	 * @param maxResultBytes - Maximum serialized result-data size.
	 * @returns Paginated definition and reference occurrences.
	 */
	public findReferences(input: FindReferencesInputType, maxResultBytes = this.#config.maxResultBytes): FindReferencesResultType {
		const context = {database: this.#database, generationId: this.#generation().id, freshness: this.getFreshness()};
		return queryReferences(context, input, maxResultBytes);
	}

	/**
	 * Finds authored modules that consume one normalized npm package.
	 *
	 * Direct usage returns modules with a package edge. Module impact traverses
	 * authored imports, keeps the direct consumer that starts every shortest
	 * path, and groups results by that root. Compact results omit locations and bindings unless evidence is requested.
	 *
	 * @param input - Package name, traversal mode, optional root, detail level, and page bounds.
	 * @param maxResultBytes - Maximum serialized result-data size.
	 * @returns Paginated dependency consumers with complete-set counts.
	 */
	public findDependencies(input: FindDependenciesInputType, maxResultBytes = this.#config.maxResultBytes): FindDependenciesResultType {
		const context = {database: this.#database, generationId: this.#generation().id, freshness: this.getFreshness()};
		return queryDependencies(context, input, maxResultBytes);
	}

	public readSymbol(input: ReadSymbolInputType): ReadSymbolResultType {
		const generation = this.#generation();
		const symbol = this.#database.getSymbol(generation.id, input.symbolId);

		if (symbol === null) {
			throw new CodeIndexError('symbol_not_found', `Unknown symbol: ${input.symbolId}`);
		}

		if (this.#coordinator.isPathDirty(symbol.path)) {
			debug('read_symbol dirty path', {symbolId: symbol.id, path: symbol.path});
			throw new StaleFileError(symbol.path);
		}

		const file = this.#database.getFile(generation.id, symbol.path);

		if (file === null) {
			throw new CodeIndexError('file_not_indexed', `Symbol file is not in the published index: ${symbol.path}`);
		}

		const absolutePath = path.resolve(this.#config.rootDir, symbol.path);

		if (!absolutePath.startsWith(`${path.resolve(this.#config.rootDir)}${sep}`)) {
			throw new CodeIndexError('invalid_argument', 'Symbol path escapes the configured root');
		}

		let content: string;

		try {
			content = readFileSync(absolutePath, 'utf8');
		} catch {
			throw new StaleFileError(symbol.path);
		}

		if (hashContent(content) !== file.sha256) {
			debug('read_symbol stale', {symbolId: symbol.id, path: symbol.path});
			throw new StaleFileError(symbol.path);
		}

		if (this.#coordinator.isPathDirty(symbol.path)) {
			debug('read_symbol became dirty', {symbolId: symbol.id, path: symbol.path});
			throw new StaleFileError(symbol.path);
		}

		debug('read_symbol', {generationId: generation.id, symbolId: symbol.id, path: symbol.path, contextLines: input.contextLines});
		const source = readSymbolSource({
			content,
			symbolStartLine: symbol.startLine,
			symbolEndLine: symbol.endLine,
			maxReadLines: this.#config.maxReadLines,
			maxResultBytes: this.#config.maxResultBytes,
			contextLines: input.contextLines,
		});

		return {
			generationId: generation.id,
			freshness: this.getFreshness(),
			symbol,
			path: symbol.path,
			startLine: source.startLine,
			endLine: source.endLine,
			source: source.source,
			truncated: source.truncatedReason !== null,
			truncatedReason: source.truncatedReason,
		};
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
			return buildGeneration({config: this.#config, database: this.#database, logger: this.#logger, scan, force});
		}

		const report = await runBuildWorkerThread({
			workerEntry: workerPath,
			config: this.#config,
			scan,
			force,
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
