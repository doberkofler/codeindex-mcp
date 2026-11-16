import {randomUUID} from 'node:crypto';
import {createAnalyticsRecorder, type AnalyticsRecorderType} from '../../core/analytics/recorder.ts';
import {buildAnalyticsDashboard} from '../../core/analytics/dashboard.ts';
import {type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
import {type ExtractorType} from '../../adapters/types.ts';
import {configuredAdapters, type ConfigType} from '../../core/config/config.ts';
import {createCodeIndex, type CodeIndex} from '../../core/generation/codeIndex.ts';
import {type IndexStatusType} from '../../core/model.ts';
import {createLogger, type LoggerType} from '../../core/logging/logger.ts';
import {IndexDatabase} from '../../core/storage/database.ts';
import {SCHEMA_VERSION} from '../../core/storage/schema.ts';
import {readVcsProvenance} from '../../adapters/vcs/vcsProvenance.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../../core/version.ts';
import {
	CONSOLE_OPERATIONS,
	type AnalyticsDashboardType,
	type AnalyticsWindowType,
	type ConsoleJobStateType,
	type ConsoleJobType,
	type ConsoleMetaType,
	type ConsoleOperationType,
	type ConsoleSnapshotType,
} from './contracts.ts';

const MAX_RETAINED_JOBS = 20;

type MutableJobType = {
	id: string;
	operation: ConsoleOperationType;
	adapterId: string | null;
	state: ConsoleJobStateType;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	message: string | null;
	result: unknown;
};

export type ConsoleServiceOptionsType = Readonly<{
	config: ConfigType;
	adapters?: readonly ExtractorType[];
	adapterDescriptors?: readonly ResolvedAdapterDescriptorType[];
	logger?: LoggerType;
}>;

const snapshotJob = (job: MutableJobType, activity: IndexStatusType['activity'] = null): ConsoleJobType => ({
	id: job.id,
	operation: job.operation,
	adapterId: job.adapterId,
	phase: job.state === 'running' ? (activity?.phase ?? null) : null,
	state: job.state,
	createdAt: job.createdAt,
	startedAt: job.startedAt,
	completedAt: job.completedAt,
	durationMs: job.durationMs,
	message: job.message,
	result: job.result,
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Owns the console's long-lived index instance, jobs, and analytics queries.
 *
 * The HTTP adapter validates transport input and translates results; indexing,
 * freshness, build serialization, and analytics aggregation stay here.
 */
export class ConsoleService {
	readonly #config: ConfigType;
	readonly #adapters: ReadonlyMap<string, ExtractorType>;
	readonly #index: CodeIndex;
	readonly #logger: LoggerType;
	readonly #analytics: AnalyticsRecorderType;
	readonly #jobs = new Map<string, MutableJobType>();
	readonly #pending: MutableJobType[] = [];
	#draining = false;
	#closed = false;

	private constructor(
		config: ConfigType,
		index: CodeIndex,
		runtime: Readonly<{
			logger: LoggerType;
			analytics: AnalyticsRecorderType;
			adapters: ReadonlyMap<string, ExtractorType>;
		}>,
	) {
		this.#config = config;
		this.#index = index;
		this.#adapters = runtime.adapters;
		this.#logger = runtime.logger;
		this.#analytics = runtime.analytics;
	}

	/**
	 * Opens the configured index and prepares console operations.
	 *
	 * @param options - Resolved configuration and optional logger.
	 * @returns The started console service.
	 */
	public static open(options: ConsoleServiceOptionsType): ConsoleService {
		const {config} = options;
		const logger = options.logger ?? createLogger({minimumLevel: config.logLevel});
		const database = IndexDatabase.open(config.databasePath, {
			rootDir: config.rootDir,
			projectId: config.projectId,
			projects: configuredAdapters(config).map((adapter) => ({
				adapterId: adapter.id,
				projectId: config.projectId,
				projectFilePath: adapter.projectFilePath,
			})),
			vcs: readVcsProvenance(config.rootDir),
		});
		const analytics = createAnalyticsRecorder({
			enabled: config.analyticsEnabled,
			path: config.analyticsPath,
			projectId: config.projectId,
			program: PROGRAM_NAME,
			programVersion: PROGRAM_VERSION,
			workingCopyId: database.getWorkingCopy()?.id ?? null,
		});
		const adapters = options.adapters ?? [];
		const index = createCodeIndex(config, database, logger, {
			analytics,
			watch: true,
			adapters,
			...(options.adapterDescriptors === undefined ? {} : {adapterDescriptors: options.adapterDescriptors}),
		});
		const service = new ConsoleService(config, index, {
			logger,
			analytics,
			adapters: new Map(adapters.map((adapter) => [adapter.id, adapter])),
		});
		service.start();
		return service;
	}

	public get meta(): ConsoleMetaType {
		return {
			program: PROGRAM_NAME,
			version: PROGRAM_VERSION,
			nodeVersion: process.version,
			schemaVersion: SCHEMA_VERSION,
			projectName: this.#config.projectName,
			rootDir: this.#config.rootDir,
			extractorId: this.#config.extractorId,
			extractorVersion: this.#adapters.get(this.#config.extractorId)?.version ?? 'unknown',
			projectFilePath: this.#config.projectFilePath,
			databasePath: this.#config.databasePath,
			analyticsPath: this.#config.analyticsPath,
			analyticsEnabled: this.#config.analyticsEnabled,
			projectId: this.#config.projectId,
			maxResultBytes: this.#config.maxResultBytes,
			maxReadLines: this.#config.maxReadLines,
			logLevel: this.#config.logLevel,
			loopbackOnly: true,
			tokenRequired: true,
			operations: CONSOLE_OPERATIONS,
		};
	}

	public get status(): IndexStatusType {
		return this.#index.getStatus();
	}

	public get jobs(): readonly ConsoleJobType[] {
		return this.snapshotJobs(this.status.activity);
	}

	public snapshot(): ConsoleSnapshotType {
		const {status} = this;
		return {meta: this.meta, status, jobs: this.snapshotJobs(status.activity)};
	}

	/**
	 * Aggregates retained analytics for one dashboard window.
	 *
	 * @param window - Requested window.
	 * @returns Aggregates only; retained events never leave the server.
	 */
	public analytics(window: AnalyticsWindowType): AnalyticsDashboardType {
		return buildAnalyticsDashboard(this.#config.analyticsPath, window);
	}

	/**
	 * Queues one allow-listed operational job.
	 *
	 * @param operation - Operation to execute.
	 * @param adapterId - Adapter target, or null for the complete workspace.
	 * @returns The queued job snapshot.
	 */
	public runOperation(operation: ConsoleOperationType, adapterId: string | null = null): ConsoleJobType {
		if (adapterId !== null && !this.#adapters.has(adapterId)) {
			throw new Error(`Unknown adapter: ${adapterId}`);
		}

		if (operation === 'verify' && adapterId !== null) {
			throw new Error('Storage verification is workspace-wide');
		}

		const job: MutableJobType = {
			id: randomUUID(),
			operation,
			adapterId,
			state: 'queued',
			createdAt: new Date().toISOString(),
			startedAt: null,
			completedAt: null,
			durationMs: null,
			message: null,
			result: null,
		};
		this.#jobs.set(job.id, job);
		this.trimJobs();
		this.#pending.push(job);
		void this.drain();
		return snapshotJob(job);
	}

	public async close(): Promise<void> {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		this.#analytics.record('console_stop');
		await this.#index.close();
		this.#analytics.close();
	}

	private start(): void {
		this.#logger.info('console_starting', {
			rootDir: this.#config.rootDir,
			projectFilePath: this.#config.projectFilePath,
			extractorId: this.#config.extractorId,
			databasePath: this.#config.databasePath,
		});
		this.#analytics.record('console_start');
		this.#index.start();
	}

	private execute(job: MutableJobType): unknown {
		const adapterIds = job.adapterId === null ? undefined : [job.adapterId];

		switch (job.operation) {
			case 'update': {
				return this.#index.ensureReady(adapterIds === undefined ? {} : {adapterIds});
			}
			case 'rebuild': {
				return this.#index.ensureReady({...(adapterIds === undefined ? {} : {adapterIds}), force: true});
			}
			case 'verify': {
				return this.#index.verify();
			}
			default: {
				throw new Error(`Unsupported console operation: ${String(job.operation)}`);
			}
		}
	}

	private async drain(): Promise<void> {
		if (this.#draining) {
			return;
		}

		this.#draining = true;

		try {
			const job = this.#pending.shift();

			if (job !== undefined) {
				await this.executeJob(job);
			}
		} finally {
			this.#draining = false;
		}

		if (this.#pending.length > 0) {
			await this.drain();
		}
	}

	private async executeJob(job: MutableJobType): Promise<void> {
		const startedAt = performance.now();
		job.state = 'running';
		job.startedAt = new Date().toISOString();

		try {
			job.result = await this.execute(job);
			job.state = 'succeeded';
		} catch (error) {
			job.state = 'failed';
			job.message = messageOf(error);
			this.#logger.error('console_operation_failed', {operation: job.operation, message: job.message});
		} finally {
			job.durationMs = Math.round(performance.now() - startedAt);
			job.completedAt = new Date().toISOString();
			this.#analytics.record('console_operation', {
				operation: job.operation,
				adapter: job.adapterId,
				durationMs: job.durationMs,
				ok: job.state === 'succeeded',
			});
		}
	}

	private snapshotJobs(activity: IndexStatusType['activity']): readonly ConsoleJobType[] {
		return [...this.#jobs.values()].map((job) => snapshotJob(job, activity)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	private trimJobs(): void {
		const finished = this.jobs.filter((job) => job.state === 'succeeded' || job.state === 'failed');

		for (const job of finished.slice(MAX_RETAINED_JOBS - 1)) {
			this.#jobs.delete(job.id);
		}
	}
}
