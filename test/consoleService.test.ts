import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type ReferenceComparisonType, type ReferenceVerificationReportType} from '../src/adapters/typescript/referenceGate.ts';
import {type BenchmarkReportType} from '../src/core/benchmark/benchTypes.ts';
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
		extractorFor: vi.fn<(...args: unknown[]) => {id: string; version: string}>((): {id: string; version: string} => ({id: 'typescript', version: '9.9.9'})),
		runBenchmarkReport: vi.fn<(...args: unknown[]) => Promise<BenchmarkReportType>>(),
		verifyTypeScriptReferences: vi.fn<(...args: unknown[]) => ReferenceVerificationReportType>(),
		runMcpCommand: vi.fn<(...args: unknown[]) => number>((...args: unknown[]) => {
			const [, io] = args as [unknown, {stdout: (line: string) => void; stderr: (line: string) => void}];
			io.stdout('installed mcp server');
			return 0;
		}),
		buildAnalyticsDashboard: vi.fn<(path: string, window: string) => AnalyticsDashboardType>(
			(_path: string, window: string): AnalyticsDashboardType => ({window}) as unknown as AnalyticsDashboardType,
		),
	};
});

vi.mock(import('../src/core/analytics/recorder.ts'), () => ({createAnalyticsRecorder: doubles.createAnalyticsRecorder}) as unknown as never);
vi.mock(import('../src/core/analytics/dashboard.ts'), () => ({buildAnalyticsDashboard: doubles.buildAnalyticsDashboard}));
vi.mock(import('../src/core/benchmark/runBenchmark.ts'), () => ({runBenchmarkReport: doubles.runBenchmarkReport}));
vi.mock(import('../src/transports/cli/mcpCommand.ts'), () => ({runMcpCommand: doubles.runMcpCommand}));
vi.mock(import('../src/adapters/registry.ts'), () => ({extractorFor: doubles.extractorFor}) as unknown as never);
vi.mock(import('../src/core/generation/codeIndex.ts'), () => ({createCodeIndex: doubles.createCodeIndex}) as unknown as never);
vi.mock(import('../src/core/logging/logger.ts'), () => ({createLogger: doubles.createLogger}));
vi.mock(import('../src/core/storage/database.ts'), () => ({IndexDatabase: {open: doubles.databaseOpen}}) as unknown as never);
vi.mock(import('../src/adapters/typescript/verifyReferences.ts'), () => ({verifyTypeScriptReferences: doubles.verifyTypeScriptReferences}));
vi.mock(import('../src/adapters/vcs/vcsProvenance.ts'), () => ({readVcsProvenance: doubles.readVcsProvenance}) as unknown as never);

const config: ConfigType = {
	projectName: 'console-project',
	rootDir: '/workspace',
	extractorId: 'typescript',
	extractorOptions: {},
	projectFilePath: '/workspace/tsconfig.json',
	projects: [{name: 'root', projectFilePath: '/workspace/tsconfig.json'}],
	databasePath: '/workspace/.codeindex/index.sqlite',
	analyticsEnabled: true,
	analyticsPath: '/workspace/.codeindex/events.jsonl',
	maxResultBytes: 32_768,
	maxReadLines: 200,
	semanticDiagnostics: false,
	projectId: 'console-project',
	logLevel: 'error',
	configPath: null,
};

const status: IndexStatusType = {
	ready: true,
	state: 'published',
	refresh: 'current',
	generationId: 'generation-1',
	building: false,
	scope: {
		root: '/workspace',
		projectName: 'console-project',
		projectFile: '/workspace/tsconfig.json',
		projects: [{name: 'root', projectFile: '/workspace/tsconfig.json'}],
		extractor: {id: 'typescript', version: '9.9.9', compilerVersion: '6.0.3'},
		projectId: 'console-project',
		workingCopyId: 'working-copy',
	},
	hashes: {source: 'source', configuration: 'configuration'},
	counts: {files: 3, symbols: 4, occurrences: 5, dependencyEdges: 1, dependencyBindings: 1, diagnostics: 0},
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

const benchmarkReport = {schemaVersion: 2, generatedAt: '2026-10-19T00:00:00.000Z'} as unknown as BenchmarkReportType;

const comparison = (overrides: Partial<ReferenceComparisonType>): ReferenceComparisonType => ({
	symbolId: 'symbol-1',
	name: 'formatUser',
	kind: 'function',
	path: 'src/user.ts',
	tags: [],
	expectedCount: 2,
	actualCount: 2,
	matchedCount: 2,
	expectedReferenceCount: 1,
	missing: [],
	extra: [],
	skip: null,
	...overrides,
});

const qualificationReport: ReferenceVerificationReportType = {
	coverage: {
		indexedSymbols: 2,
		locatedSymbols: 2,
		unlocatedSymbols: 0,
		sampledSymbols: 2,
		symbolsWithNonDefinitionReferences: 1,
		skipped: [],
		byKind: {function: 2},
		byTag: {},
		referencedByTag: {},
	},
	accuracy: {expected: 2, actual: 2, matched: 2, missing: 0, extra: 0, recall: 1, precision: 1},
	comparisons: [
		comparison({}),
		comparison({symbolId: 'symbol-2', name: 'missing', missing: [{path: 'src/user.ts', startOffset: 1, endOffset: 2, role: 'reference'}]}),
		comparison({symbolId: 'symbol-3', name: 'skipped', skip: 'declaration_not_located'}),
	],
	gate: {ok: false, failures: [{kind: 'missing_construct', detail: 'missing'}], targets: {samples: 100, recall: 0.98, precision: 0.98}},
};

const openService = (options: Readonly<{logger?: LoggerType; mcpPath?: string; config?: ConfigType}> = {}): ConsoleService =>
	ConsoleService.open({
		config: options.config ?? config,
		...(options.logger === undefined ? {} : {logger: options.logger}),
		...(options.mcpPath === undefined ? {} : {mcpPath: options.mcpPath}),
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
		doubles.extractorFor.mockReturnValue({id: 'typescript', version: '9.9.9'});
		doubles.index.close.mockResolvedValue(undefined);
		doubles.index.getStatus.mockReturnValue(status);
		doubles.index.ensureReady.mockResolvedValue(verification);
		doubles.index.verify.mockResolvedValue(verification);
		doubles.runBenchmarkReport.mockResolvedValue(benchmarkReport);
		doubles.verifyTypeScriptReferences.mockReturnValue(qualificationReport);
		doubles.buildAnalyticsDashboard.mockImplementation(
			(_path: string, window: string): AnalyticsDashboardType => ({window}) as unknown as AnalyticsDashboardType,
		);
	});

	afterEach(async () => {
		await service?.close();
		service = undefined;
	});

	it('opens the database, analytics, and watched index with resolved configuration', () => {
		service = openService({logger: doubles.logger, mcpPath: '/app/mcp.mjs'});

		expect(doubles.databaseOpen).toHaveBeenCalledWith(config.databasePath, {
			rootDir: config.rootDir,
			projectFilePath: config.projectFilePath,
			extractorId: config.extractorId,
			projectId: config.projectId,
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
		expect(doubles.createCodeIndex).toHaveBeenCalledWith(config, expect.anything(), doubles.logger, {analytics: doubles.analytics, watch: true});
		expect(doubles.index.start).toHaveBeenCalledWith();
		expect(doubles.logger.info).toHaveBeenCalledWith('console_starting', expect.objectContaining({rootDir: config.rootDir}));
		expect(doubles.analytics.record).toHaveBeenCalledWith('console_start');
	});

	it('uses the configured logger when none is injected', () => {
		service = openService({mcpPath: '/app/mcp.mjs'});

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
		expect(service.meta.operations).toContain('mcp-install');
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
	doubles.extractorFor.mockReturnValue({id: 'typescript', version: '9.9.9'});
	doubles.index.close.mockResolvedValue(undefined);
	doubles.index.getStatus.mockReturnValue(status);
	doubles.index.ensureReady.mockResolvedValue(verification);
	doubles.index.verify.mockResolvedValue(verification);
	doubles.runBenchmarkReport.mockResolvedValue(benchmarkReport);
	doubles.verifyTypeScriptReferences.mockReturnValue(qualificationReport);
};

const closeJobs = async (): Promise<void> => {
	await jobService?.close();
	jobService = undefined;
};

const startJobs = (): ConsoleService => {
	jobService = openService({logger: doubles.logger, mcpPath: '/app/mcp.mjs'});
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
		expect(doubles.index.ensureReady).toHaveBeenNthCalledWith(1);
		expect(doubles.index.ensureReady).toHaveBeenNthCalledWith(2, {force: true});
		expect(doubles.index.verify).toHaveBeenCalledWith();
		expect(doubles.analytics.record).toHaveBeenCalledWith('console_operation', expect.objectContaining({ok: true}));
	});

	it('runs benchmarks and qualification reports', async () => {
		const consoleService = start();
		const benchmark = await execute(consoleService, 'benchmark');
		const qualify = await execute(consoleService, 'qualify');

		expect(doubles.runBenchmarkReport).toHaveBeenCalledWith({config, iterations: 10, force: false});
		expect(benchmark.result).toBe(benchmarkReport);
		expect(qualify.state).toBe('succeeded');
		expect(qualify.result).toStrictEqual({
			coverage: qualificationReport.coverage,
			accuracy: qualificationReport.accuracy,
			gate: qualificationReport.gate,
			disagreements: [
				expect.objectContaining({name: 'missing', missing: 1, extra: 0, skip: null}),
				expect.objectContaining({name: 'skipped', missing: 0, extra: 0, skip: 'declaration_not_located'}),
			],
		});
	});
});

describe('console service job failures and retention', () => {
	beforeEach(resetJobs);
	afterEach(closeJobs);

	const start = startJobs;

	it('installs the MCP server through the shared command', async () => {
		const consoleService = start();
		const job = await execute(consoleService, 'mcp-install');

		expect(doubles.runMcpCommand).toHaveBeenCalledWith(
			['install', '--root', config.rootDir, '--json'],
			expect.objectContaining({stdout: expect.any(Function), stderr: expect.any(Function)}),
			{mcpPath: '/app/mcp.mjs'},
		);
		expect(job).toMatchObject({state: 'succeeded', result: {installed: true, output: 'installed mcp server'}});
	});

	it('fails the MCP install when the bundle path is unavailable', async () => {
		jobService = openService({logger: doubles.logger});
		const consoleService = jobService;
		const job = await execute(consoleService, 'mcp-install');

		expect(job).toMatchObject({state: 'failed', message: 'MCP bundle path is unavailable'});
		expect(doubles.runMcpCommand).not.toHaveBeenCalled();
	});

	it('reports command output when MCP installation fails', async () => {
		const consoleService = start();

		doubles.runMcpCommand.mockImplementationOnce((...args: unknown[]) => {
			const [, io] = args as [unknown, {stderr: (line: string) => void}];
			io.stderr('permission denied');
			return 1;
		});

		const job = await execute(consoleService, 'mcp-install');

		expect(job).toMatchObject({state: 'failed', message: 'permission denied'});
		expect(doubles.logger.error).toHaveBeenCalledWith('console_operation_failed', expect.objectContaining({operation: 'mcp-install'}));
	});

	it('defaults failed installations without output', async () => {
		const consoleService = start();

		doubles.runMcpCommand.mockReturnValueOnce(2);

		const job = await execute(consoleService, 'mcp-install');

		expect(job).toMatchObject({state: 'failed', message: 'MCP install failed'});
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
