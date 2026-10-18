import {randomUUID} from 'node:crypto';
import {createAnalyticsRecorder, type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {buildAnalyticsDashboard} from '../analytics/dashboard.ts';
import {runBenchmarkReport} from '../benchmark/runBenchmark.ts';
import {runMcpCommand} from '../cli/mcpCommand.ts';
import {type ConfigType} from '../config/config.ts';
import {extractorFor} from '../extractors/registry.ts';
import {createCodeIndex, type CodeIndex} from '../index/codeIndex.ts';
import {type IndexStatusType} from '../index/model.ts';
import {createLogger, type LoggerType} from '../logging/logger.ts';
import {IndexDatabase} from '../storage/database.ts';
import {SCHEMA_VERSION} from '../storage/schema.ts';
import {runReferenceVerification} from '../extractors/typescript/verifyReferences.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../version.ts';
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
	logger?: LoggerType;
	mcpPath?: string;
}>;

const snapshotJob = (job: MutableJobType): ConsoleJobType => ({
	id: job.id,
	operation: job.operation,
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
	readonly #index: CodeIndex;
	readonly #logger: LoggerType;
	readonly #analytics: AnalyticsRecorderType;
	readonly #mcpPath: string | null;
	readonly #jobs = new Map<string, MutableJobType>();
	readonly #pending: MutableJobType[] = [];
	#draining = false;
	#closed = false;

	private constructor(config: ConfigType, index: CodeIndex, runtime: Readonly<{logger: LoggerType; analytics: AnalyticsRecorderType; mcpPath: string | null}>) {
		this.#config = config;
		this.#index = index;
		this.#logger = runtime.logger;
		this.#analytics = runtime.analytics;
		this.#mcpPath = runtime.mcpPath;
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
			projectFilePath: config.projectFilePath,
			extractorId: config.extractorId,
			projectId: config.projectId,
		});
		const analytics = createAnalyticsRecorder({
			enabled: config.analyticsEnabled,
			path: config.analyticsPath,
			projectId: config.projectId,
			program: PROGRAM_NAME,
			programVersion: PROGRAM_VERSION,
			workingCopyId: database.getWorkingCopy()?.id ?? null,
		});
		const index = createCodeIndex(config, database, logger, {analytics, watch: true});
		const service = new ConsoleService(config, index, {logger, analytics, mcpPath: options.mcpPath ?? null});
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
			extractorVersion: extractorFor(this.#config.extractorId).version,
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
		return [...this.#jobs.values()].map((job) => snapshotJob(job)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	public snapshot(): ConsoleSnapshotType {
		return {meta: this.meta, status: this.status, jobs: this.jobs};
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
	 * @returns The queued job snapshot.
	 */
	public runOperation(operation: ConsoleOperationType): ConsoleJobType {
		const job: MutableJobType = {
			id: randomUUID(),
			operation,
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

	private execute(operation: ConsoleOperationType): unknown {
		switch (operation) {
			case 'update': {
				return this.#index.ensureReady();
			}
			case 'rebuild': {
				return this.#index.ensureReady({force: true});
			}
			case 'verify': {
				return this.#index.verify();
			}
			case 'benchmark': {
				return runBenchmarkReport({config: this.#config, iterations: 10, force: false});
			}
			case 'mcp-install': {
				return this.installMcp();
			}
			case 'verify-references': {
				const report = runReferenceVerification(this.#config);

				return {
					samples: report.samples,
					recall: Number(report.recall.toFixed(4)),
					precision: Number(report.precision.toFixed(4)),
					disagreements: report.comparisons.filter((comparison) => comparison.missing.length > 0 || comparison.extra.length > 0).length,
					comparisons: report.comparisons.map((comparison) => ({
						name: comparison.name,
						kind: comparison.kind,
						path: comparison.path,
						expected: comparison.expectedCount,
						actual: comparison.actualCount,
						matched: comparison.matchedCount,
						missing: comparison.missing.length,
						extra: comparison.extra.length,
					})),
				};
			}
			default: {
				throw new Error(`Unsupported console operation: ${String(operation)}`);
			}
		}
	}

	private installMcp(): unknown {
		if (this.#mcpPath === null) {
			throw new Error('MCP bundle path is unavailable');
		}

		const output: string[] = [];
		const code = runMcpCommand(
			['install', '--root', this.#config.rootDir, '--json'],
			{
				stdout: (line) => {
					output.push(line);
				},
				stderr: (line) => {
					output.push(line);
				},
			},
			{mcpPath: this.#mcpPath},
		);

		if (code !== 0) {
			throw new Error(output.join('\n') || 'MCP install failed');
		}

		return {installed: true, output: output.join('\n')};
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
			job.result = await this.execute(job.operation);
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
				durationMs: job.durationMs,
				ok: job.state === 'succeeded',
			});
		}
	}

	private trimJobs(): void {
		const finished = this.jobs.filter((job) => job.state === 'succeeded' || job.state === 'failed');

		for (const job of finished.slice(MAX_RETAINED_JOBS - 1)) {
			this.#jobs.delete(job.id);
		}
	}
}
