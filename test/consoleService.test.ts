import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {typeScriptExtractor} from '@codeindex/adapter-typescript/index';
import {type ConfigType} from '../src/core/config/config.ts';
import {type LoggerType} from '../src/core/logging/logger.ts';
import {type IndexStatusType, type IndexVerificationType} from '../src/core/model.ts';
import {type AnalyticsDashboardType} from '../src/core/analytics/contracts.ts';
import {type ConsoleJobType, type ConsoleOperationType} from '../src/transports/console/contracts.ts';
import {ConsoleService} from '../src/transports/console/service.ts';

const doubles = vi.hoisted(() => {
	const logger = {
		debug: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
		info: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
		warn: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
		error: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
	};
	const index = {
		start: vi.fn<() => void>(),
		close: vi.fn<() => Promise<void>>(),
		getStatus: vi.fn<() => IndexStatusType>(),
		ensureReady: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
		verify: vi.fn<() => IndexVerificationType>(),
	};
	const analytics = {
		enabled: true,
		path: '/tmp/codeindex/events.jsonl',
		record: vi.fn<(event: string, fields?: Readonly<Record<string, unknown>>) => unknown>(),
		close: vi.fn<() => void>(),
	};

	return {
		logger,
		index,
		analytics,
		createLogger: vi.fn<(options: unknown) => typeof logger>((): typeof logger => logger),
		createCodeIndex: vi.fn<(...args: unknown[]) => typeof index>((): typeof index => index),
		createAnalyticsRecorder: vi.fn<(...args: unknown[]) => typeof analytics>((): typeof analytics => analytics),
		databaseOpen: vi.fn<(...args: unknown[]) => {getWorkingCopy: () => {id: string} | undefined}>((): {getWorkingCopy: () => {id: string} | undefined} => ({
			getWorkingCopy: () => ({id: 'working-copy'}),
		})),
		readVcsProvenance: vi.fn<(...args: unknown[]) => unknown>((): unknown => ({available: false})),
		buildAnalyticsDashboard: vi.fn<(path: string, window: string) => AnalyticsDashboardType>(
			(_path: string, window: string): AnalyticsDashboardType => ({window}) as unknown as AnalyticsDashboardType,
		),
	};
});

vi.mock(import('../src/core/analytics/recorder.ts'), () => ({createAnalyticsRecorder: doubles.createAnalyticsRecorder}) as unknown as never);
vi.mock(import('../src/core/analytics/dashboard.ts'), () => ({buildAnalyticsDashboard: doubles.buildAnalyticsDashboard}));
vi.mock(import('../src/core/generation/codeIndex.ts'), () => ({createCodeIndex: doubles.createCodeIndex}) as unknown as never);
vi.mock(import('../src/core/logging/logger.ts'), () => ({createLogger: doubles.createLogger}));
vi.mock(import('../src/core/storage/database.ts'), () => ({IndexDatabase: {open: doubles.databaseOpen}}) as unknown as never);
vi.mock(import('../src/adapters/vcs/vcsProvenance.ts'), () => ({readVcsProvenance: doubles.readVcsProvenance}) as unknown as never);

const config: ConfigType = {
	projectName: 'console-project',
	rootDir: '/workspace',
	extractorId: 'typescript',
	extractorOptions: {},
	projectFilePath: '/workspace/tsconfig.json',
	projects: [{name: 'root', projectFilePath: '/workspace/tsconfig.json'}],
	storageDirectory: '/workspace/.codeindex',
	databasePath: '/workspace/.codeindex/index.sqlite',
	analyticsEnabled: true,
	analyticsPath: '/workspace/.codeindex/events.jsonl',
	maxResultBytes: 32_768,
	maxReadLines: 200,
	semanticDiagnostics: false,
	freshnessDebounceMs: 1000,
	projectId: 'console-project',
	logLevel: 'error',
	configPath: null,
};

const status: IndexStatusType = {
	ready: true,
	state: 'published',
	refresh: 'current',
	generationId: 'generation-1',
	revision: 1,
	building: false,
	activity: null,
	scope: {
		root: '/workspace',
		projectName: 'console-project',
		projectFile: '/workspace/tsconfig.json',
		projects: [{name: 'root', projectFile: '/workspace/tsconfig.json', adapter: 'typescript'}],
		adapters: [
			{
				id: 'typescript',
				displayName: 'TypeScript / JavaScript',
				version: '9.9.9',
				required: true,
				coverage: 'present',
				absenceReason: null,
				revision: 1,
				counts: {files: 3, symbols: 4, occurrences: 5, dependencyEdges: 1, dependencyBindings: 1, diagnostics: 0},
				stages: {scanMs: 1, compilerMs: 2, extractionMs: 3},
				freshness: {state: 'current', checkedAt: '2026-10-19T00:00:00.000Z', dirtyFileCount: 0},
				compilerVersion: '6.0.3',
				declaredCompilerVersion: '6.0.3',
				compilerDrift: false,
				contexts: ['root'],
				limitations: [],
			},
		],
		extractor: {id: 'typescript', version: '9.9.9', compilerVersion: '6.0.3', declaredCompilerVersion: '6.0.3', compilerDrift: false},
		projectId: 'console-project',
		workingCopyId: 'working-copy',
	},
	hashes: {source: 'source', configuration: 'configuration'},
	counts: {files: 3, symbols: 4, occurrences: 5, dependencyEdges: 1, dependencyBindings: 1, diagnostics: 0},
	buildStats: [],
	build: {startedAt: null, completedAt: null, durationMs: null, stages: null},
	freshness: {state: 'current', checkedAt: '2026-10-19T00:00:00.000Z', dirtyFileCount: 0, staleFiles: 0, sourceChanged: false},
	lease: null,
	exclusions: [],
	lastError: null,
};

const verification: IndexVerificationType = {
	generationId: 'generation-1',
	integrity: 'ok',
	metadataMatches: true,
	counts: {files: 3, symbols: 4, occurrences: 5, dependencyEdges: 1, dependencyBindings: 1, diagnostics: 0},
};

const openService = (options: Readonly<{logger?: LoggerType; config?: ConfigType}> = {}): ConsoleService =>
	ConsoleService.open({
		config: options.config ?? config,
		adapters: [{...typeScriptExtractor, version: '9.9.9'}],
		...(options.logger === undefined ? {} : {logger: options.logger}),
	});

const jobById = (service: ConsoleService, id: string): ConsoleJobType | undefined => service.jobs.find((job) => job.id === id);

const waitForJob = async (service: ConsoleService, id: string): Promise<ConsoleJobType> => {
	await vi.waitFor(() => {
		const job = jobById(service, id);
		expect(job?.state === 'succeeded' || job?.state === 'failed').toBe(true);
	});

	const job = jobById(service, id);

	if (job === undefined) {
		throw new Error(`Job ${id} disappeared`);
	}

	return job;
};

const execute = async (service: ConsoleService, operation: ConsoleOperationType): Promise<ConsoleJobType> => {
	const job = await waitForJob(service, service.runOperation(operation).id);
	return job;
};

describe('console service wiring', () => {
	let service: ConsoleService | undefined;

	beforeEach(() => {
		vi.resetAllMocks();
		doubles.databaseOpen.mockReturnValue({getWorkingCopy: () => ({id: 'working-copy'})});
		doubles.createLogger.mockReturnValue(doubles.logger);
		doubles.createCodeIndex.mockReturnValue(doubles.index);
		doubles.createAnalyticsRecorder.mockReturnValue(doubles.analytics);
		doubles.readVcsProvenance.mockReturnValue({available: false});
		doubles.index.close.mockResolvedValue(undefined);
		doubles.index.getStatus.mockReturnValue(status);
		doubles.index.ensureReady.mockResolvedValue(verification);
		doubles.index.verify.mockResolvedValue(verification);
		doubles.buildAnalyticsDashboard.mockImplementation(
			(_path: string, window: string): AnalyticsDashboardType => ({window}) as unknown as AnalyticsDashboardType,
		);
	});

	afterEach(async () => {
		await service?.close();
		service = undefined;
	});

	it('opens the database, analytics, and watched index with resolved configuration', () => {
		service = openService({logger: doubles.logger});

		expect(doubles.databaseOpen).toHaveBeenCalledWith(config.databasePath, {
			rootDir: config.rootDir,
			projectId: config.projectId,
			projects: [
				{
					adapterId: config.extractorId,
					projectId: config.projectId,
					projectFilePath: config.projectFilePath,
				},
			],
			vcs: {available: false},
		});
		expect(doubles.createAnalyticsRecorder).toHaveBeenCalledWith({
			enabled: true,
			path: config.analyticsPath,
			projectId: config.projectId,
			program: 'codeindex-mcp',
			programVersion: expect.any(String),
			workingCopyId: 'working-copy',
		});
		expect(doubles.createCodeIndex).toHaveBeenCalledWith(config, expect.anything(), doubles.logger, {
			analytics: doubles.analytics,
			watch: true,
			adapters: [{...typeScriptExtractor, version: '9.9.9'}],
		});
		expect(doubles.index.start).toHaveBeenCalledWith();
		expect(doubles.logger.info).toHaveBeenCalledWith('console_starting', expect.objectContaining({rootDir: config.rootDir}));
		expect(doubles.analytics.record).toHaveBeenCalledWith('console_start');
	});

	it('uses the configured logger when none is injected', () => {
		service = openService();

		expect(doubles.createLogger).toHaveBeenCalledWith({minimumLevel: 'error'});
		expect(doubles.createCodeIndex).toHaveBeenCalledWith(config, expect.anything(), doubles.logger, expect.anything());
	});

	it('exposes metadata, status, jobs, and snapshots', () => {
		service = openService({logger: doubles.logger});
		const job = service.runOperation('verify');

		expect(service.meta).toMatchObject({
			program: 'codeindex-mcp',
			projectName: config.projectName,
			rootDir: config.rootDir,
			extractorVersion: '9.9.9',
			loopbackOnly: true,
			tokenRequired: true,
		});
		expect(service.meta.operations).toStrictEqual(['update', 'rebuild', 'verify']);
		expect(service.status).toBe(status);
		expect(service.snapshot()).toMatchObject({meta: service.meta, status, jobs: [{id: job.id, operation: 'verify'}]});
	});

	it('delegates analytics windows without exposing retained events', () => {
		service = openService({logger: doubles.logger});

		const dashboard = service.analytics('7d');

		expect(doubles.buildAnalyticsDashboard).toHaveBeenCalledWith(config.analyticsPath, '7d');
		expect(dashboard).toMatchObject({window: '7d'});
	});

	it('records the stop event and closes resources exactly once', async () => {
		service = openService({logger: doubles.logger});

		await service.close();
		await service.close();

		expect(doubles.analytics.record).toHaveBeenCalledWith('console_stop');
		expect(doubles.index.close).toHaveBeenCalledWith();
		expect(doubles.analytics.close).toHaveBeenCalledWith();
	});
});

let jobService: ConsoleService | undefined;

const resetJobs = (): void => {
	vi.resetAllMocks();
	doubles.databaseOpen.mockReturnValue({getWorkingCopy: () => ({id: 'working-copy'})});
	doubles.createLogger.mockReturnValue(doubles.logger);
	doubles.createCodeIndex.mockReturnValue(doubles.index);
	doubles.createAnalyticsRecorder.mockReturnValue(doubles.analytics);
	doubles.readVcsProvenance.mockReturnValue({available: false});
	doubles.index.close.mockResolvedValue(undefined);
	doubles.index.getStatus.mockReturnValue(status);
	doubles.index.ensureReady.mockResolvedValue(verification);
	doubles.index.verify.mockResolvedValue(verification);
};

const closeJobs = async (): Promise<void> => {
	await jobService?.close();
	jobService = undefined;
};

const startJobs = (): ConsoleService => {
	jobService = openService({logger: doubles.logger});
	return jobService;
};

describe('console service job execution', () => {
	beforeEach(resetJobs);
	afterEach(closeJobs);

	const start = startJobs;

	it('runs update, rebuild, and verify through the index', async () => {
		const consoleService = start();
		const update = await execute(consoleService, 'update');
		const rebuild = await execute(consoleService, 'rebuild');
		const verify = await execute(consoleService, 'verify');

		expect(update).toMatchObject({state: 'succeeded', result: verification});
		expect(rebuild).toMatchObject({state: 'succeeded', result: verification});
		expect(verify).toMatchObject({state: 'succeeded', result: verification});
		expect(doubles.index.ensureReady).toHaveBeenNthCalledWith(1, {});
		expect(doubles.index.ensureReady).toHaveBeenNthCalledWith(2, {force: true});
		expect(doubles.index.verify).toHaveBeenCalledWith();
		expect(doubles.analytics.record).toHaveBeenCalledWith('console_operation', expect.objectContaining({ok: true}));
	});

	it('scopes update and rebuild to one adapter', async () => {
		const consoleService = start();
		const update = await waitForJob(consoleService, consoleService.runOperation('update', 'typescript').id);
		const rebuild = await waitForJob(consoleService, consoleService.runOperation('rebuild', 'typescript').id);

		expect(update).toMatchObject({state: 'succeeded', adapterId: 'typescript'});
		expect(rebuild).toMatchObject({state: 'succeeded', adapterId: 'typescript'});
		expect(doubles.index.ensureReady).toHaveBeenNthCalledWith(1, {adapterIds: ['typescript']});
		expect(doubles.index.ensureReady).toHaveBeenNthCalledWith(2, {adapterIds: ['typescript'], force: true});
	});
});

describe('console service job failures and retention', () => {
	beforeEach(resetJobs);
	afterEach(closeJobs);

	const start = startJobs;

	it('rejects unknown adapter targets and scoped verification', () => {
		const consoleService = start();

		expect(() => consoleService.runOperation('update', 'unknown')).toThrow('Unknown adapter: unknown');
		expect(() => consoleService.runOperation('verify', 'typescript')).toThrow('Storage verification is workspace-wide');
	});

	it('records thrown errors and non-error failures', async () => {
		const consoleService = start();

		doubles.index.ensureReady.mockRejectedValueOnce(new Error('refresh failed'));
		doubles.index.verify.mockRejectedValueOnce('not an error');

		const thrown = await execute(consoleService, 'update');
		const literal = await execute(consoleService, 'verify');

		expect(thrown).toMatchObject({state: 'failed', message: 'refresh failed'});
		expect(literal).toMatchObject({state: 'failed', message: 'not an error'});
		expect(doubles.logger.error).toHaveBeenCalledTimes(2);
	});

	it('rejects unsupported operations with a stable message', async () => {
		const consoleService = start();
		const unsupported = 'clean' as unknown as ConsoleOperationType;
		const job = await waitForJob(consoleService, consoleService.runOperation(unsupported).id);

		expect(job).toMatchObject({state: 'failed', message: 'Unsupported console operation: clean'});
	});

	it('serializes queued jobs and drains them after the active one', async () => {
		const consoleService = start();
		const first = consoleService.runOperation('update');
		const second = consoleService.runOperation('verify');

		expect(jobById(consoleService, second.id)?.state).toBe('queued');

		await expect(waitForJob(consoleService, first.id)).resolves.toMatchObject({state: 'succeeded'});
		await expect(waitForJob(consoleService, second.id)).resolves.toMatchObject({state: 'succeeded'});
	});

	it('trims retained jobs to twenty on the next submission', async () => {
		const consoleService = start();

		await Promise.all(
			Array.from({length: 25}, async () => {
				await execute(consoleService, 'verify');
			}),
		);

		expect(consoleService.jobs).toHaveLength(25);

		await execute(consoleService, 'verify');
		expect(consoleService.jobs).toHaveLength(20);
	});
});
