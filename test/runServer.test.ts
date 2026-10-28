import process from 'node:process';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type ConfigType} from '../src/core/config/config.ts';
import {run as runServer} from '../src/transports/mcp/runServer.ts';

const doubles = vi.hoisted(() => {
	const logger = {
		debug: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
		info: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
		warn: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
		error: vi.fn<(message: string, fields?: Readonly<Record<string, unknown>>) => void>(),
	};
	const analytics = {
		enabled: true,
		path: '/workspace/.codeindex/events.jsonl',
		record: vi.fn<(event: string, fields?: Readonly<Record<string, unknown>>) => unknown>(),
		close: vi.fn<() => void>(),
	};
	const index = {start: vi.fn<() => void>(), close: vi.fn<() => Promise<void>>()};
	const database = {getWorkingCopy: vi.fn<() => {id: string} | undefined>(() => ({id: 'working-copy'}))};
	const mcpServer = {connect: vi.fn<() => Promise<void>>()};
	const stdio: {
		factory: (() => unknown) | null;
		handle: {close: ReturnType<typeof vi.fn<() => Promise<void>>>};
		serve: ReturnType<typeof vi.fn<(factory: () => unknown) => {close: ReturnType<typeof vi.fn<() => Promise<void>>>}>>;
	} = {
		factory: null,
		handle: {close: vi.fn<() => Promise<void>>()},
		serve: vi.fn<(factory: () => unknown) => {close: ReturnType<typeof vi.fn<() => Promise<void>>>}>((factory: () => unknown) => {
			stdio.factory = factory;
			return stdio.handle;
		}),
	};

	return {
		logger,
		analytics,
		index,
		database,
		mcpServer,
		stdio,
		loadConfig: vi.fn<(source: Readonly<Record<string, string | undefined>>) => ConfigType>(),
		createLogger: vi.fn<(options: unknown) => typeof logger>(() => logger),
		createAnalyticsRecorder: vi.fn<(options: unknown) => typeof analytics>(() => analytics),
		createCodeIndex: vi.fn<(...args: unknown[]) => typeof index>(() => index),
		buildMcpServer: vi.fn<(...args: unknown[]) => typeof mcpServer>(() => mcpServer),
		databaseOpen: vi.fn<(...args: unknown[]) => typeof database>(() => database),
		readVcsProvenance: vi.fn<(...args: unknown[]) => {available: boolean}>(() => ({available: false})),
		extractorFor: vi.fn<(id: string) => {discoveryText: string}>(() => ({discoveryText: 'TypeScript discovery'})),
	};
});

vi.mock(import('@modelcontextprotocol/server/stdio'), () => ({serveStdio: doubles.stdio.serve}) as unknown as never);
vi.mock(import('../src/core/analytics/recorder.ts'), () => ({createAnalyticsRecorder: doubles.createAnalyticsRecorder}) as unknown as never);
vi.mock(import('../src/core/config/config.ts'), () => ({loadConfig: doubles.loadConfig}));
vi.mock(import('../src/core/generation/codeIndex.ts'), () => ({createCodeIndex: doubles.createCodeIndex}) as unknown as never);
vi.mock(import('../src/core/logging/logger.ts'), () => ({createLogger: doubles.createLogger}));
vi.mock(import('../src/transports/mcp/buildMcpServer.ts'), () => ({buildMcpServer: doubles.buildMcpServer}) as unknown as never);
vi.mock(import('../src/core/storage/database.ts'), () => ({IndexDatabase: {open: doubles.databaseOpen}}) as unknown as never);
vi.mock(import('../src/adapters/vcs/vcsProvenance.ts'), () => ({readVcsProvenance: doubles.readVcsProvenance}) as unknown as never);
vi.mock(import('../src/adapters/registry.ts'), () => ({extractorFor: doubles.extractorFor}) as unknown as never);

const config: ConfigType = {
	projectName: 'mcp-project',
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
	projectId: 'mcp-project',
	logLevel: 'error',
	configPath: null,
};

type ListenerType = (...args: any[]) => void;

const lifecycleEvents = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;

const addedListeners: Readonly<{event: string; listener: ListenerType}>[] = [];
const exitCodes: (string | number | null | undefined)[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn>;

const captureListeners = (before: ReadonlyMap<string, readonly ListenerType[]>): void => {
	for (const event of lifecycleEvents) {
		const existing = before.get(event) ?? [];

		for (const listener of process.listeners(event)) {
			const candidate = listener as ListenerType;

			if (!existing.includes(candidate)) {
				addedListeners.push({event, listener: candidate});
			}
		}
	}
};

const listenerOf = (event: string): ListenerType => {
	const entry = addedListeners.find((candidate) => candidate.event === event);

	if (entry === undefined) {
		throw new Error(`Missing ${event} listener`);
	}

	return entry.listener;
};

const start = (options: Parameters<typeof runServer>[0] = {}): void => {
	const before = new Map<string, readonly ListenerType[]>(lifecycleEvents.map((event) => [event, process.listeners(event) as ListenerType[]]));

	runServer(options);
	captureListeners(before);
};

const resetRuntime = (): void => {
	vi.resetAllMocks();
	doubles.loadConfig.mockReturnValue(config);
	doubles.createLogger.mockReturnValue(doubles.logger);
	doubles.createAnalyticsRecorder.mockReturnValue(doubles.analytics);
	doubles.createCodeIndex.mockReturnValue(doubles.index);
	doubles.buildMcpServer.mockReturnValue(doubles.mcpServer);
	doubles.databaseOpen.mockReturnValue(doubles.database);
	doubles.readVcsProvenance.mockReturnValue({available: false});
	doubles.extractorFor.mockReturnValue({discoveryText: 'TypeScript discovery'});
	doubles.database.getWorkingCopy.mockReturnValue({id: 'working-copy'});
	doubles.index.close.mockResolvedValue(undefined);
	doubles.stdio.handle.close.mockResolvedValue(undefined);
	vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
		exitCodes.push(code);
		return undefined as never;
	});
	stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
};

const cleanupRuntime = (): void => {
	while (addedListeners.length > 0) {
		const entry = addedListeners.pop();

		if (entry !== undefined) {
			process.removeListener(entry.event, entry.listener);
		}
	}

	vi.restoreAllMocks();
	exitCodes.length = 0;
};

describe('MCP server startup', () => {
	beforeEach(resetRuntime);
	afterEach(cleanupRuntime);

	it('starts the watched index and MCP transport', () => {
		start({workerEntry: '/app/worker.js'});

		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('codeindex-mcp'));
		expect(doubles.loadConfig).toHaveBeenCalledWith(process.env);
		expect(doubles.createLogger).toHaveBeenCalledWith({minimumLevel: 'error'});
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
		expect(doubles.createCodeIndex).toHaveBeenCalledWith(config, doubles.database, doubles.logger, {
			workerEntry: '/app/worker.js',
			analytics: doubles.analytics,
		});
		expect(doubles.logger.info).toHaveBeenCalledWith('code_index_starting', expect.objectContaining({workingCopyId: 'working-copy'}));
		expect(doubles.analytics.record).toHaveBeenCalledWith('process_start', expect.objectContaining({schemaVersion: expect.any(String)}));
		expect(doubles.index.start.mock.calls).toStrictEqual([[]]);
		const registered = new Set(addedListeners.map((entry) => entry.event));

		expect(lifecycleEvents.every((event) => registered.has(event))).toBe(true);
	});

	it('builds the MCP server from the running index', () => {
		start();
		const {factory} = doubles.stdio;

		if (factory === null) {
			throw new Error('Expected a server factory');
		}

		expect(factory()).toBe(doubles.mcpServer);
		expect(doubles.buildMcpServer).toHaveBeenCalledWith({
			index: doubles.index,
			logger: doubles.logger,
			analytics: doubles.analytics,
			maxResultBytes: config.maxResultBytes,
			extractorDiscoveryText: 'TypeScript discovery',
		});
		expect(doubles.extractorFor).toHaveBeenCalledWith(config.extractorId);
	});

	it('reports a missing working copy', () => {
		doubles.database.getWorkingCopy.mockReturnValue(undefined);

		start();

		expect(doubles.createAnalyticsRecorder).toHaveBeenCalledWith(expect.objectContaining({workingCopyId: null}));
		expect(doubles.logger.info).toHaveBeenCalledWith('code_index_starting', expect.objectContaining({workingCopyId: null}));
	});
});

describe('MCP server lifecycle', () => {
	beforeEach(resetRuntime);
	afterEach(cleanupRuntime);

	it('closes the transport and index on a shutdown signal', async () => {
		start();

		listenerOf('SIGINT')();

		await vi.waitFor(() => {
			expect(exitCodes).toStrictEqual([0]);
		});

		expect(doubles.logger.info).toHaveBeenCalledWith('code_index_stopping', {signal: 'SIGINT'});
		expect(doubles.analytics.record).toHaveBeenCalledWith('process_stop', {signal: 'SIGINT'});
		expect(doubles.stdio.handle.close.mock.calls).toStrictEqual([[]]);
		expect(doubles.index.close.mock.calls).toStrictEqual([[]]);
	});

	it('ignores repeated shutdown signals', async () => {
		start();
		const shutdown = listenerOf('SIGTERM');

		shutdown();
		shutdown();

		await vi.waitFor(() => {
			expect(exitCodes).toStrictEqual([0]);
		});

		expect(doubles.logger.info.mock.calls.filter(([message]) => message === 'code_index_stopping')).toHaveLength(1);
		expect(doubles.stdio.handle.close.mock.calls).toStrictEqual([[]]);
	});

	it('still closes the index when the transport close fails', async () => {
		doubles.stdio.handle.close.mockRejectedValueOnce(new Error('close failed'));

		start();
		listenerOf('SIGINT')();

		await vi.waitFor(() => {
			expect(exitCodes).toStrictEqual([0]);
		});

		expect(doubles.logger.error).toHaveBeenCalledWith('code_index_close_failed', {message: 'close failed'});
		expect(doubles.index.close.mock.calls).toStrictEqual([[]]);
	});

	it('logs uncaught exceptions and exits with failure', () => {
		start();

		listenerOf('uncaughtException')(new Error('boom'));

		expect(doubles.logger.error).toHaveBeenCalledWith('uncaught_exception', {message: 'boom', stack: expect.any(String)});
		expect(exitCodes).toStrictEqual([1]);
	});

	it('logs unhandled rejections for errors and values', () => {
		start();
		const rejection = listenerOf('unhandledRejection');

		rejection(new Error('rejected'));
		rejection('plain reason');

		expect(doubles.logger.error).toHaveBeenNthCalledWith(1, 'unhandled_rejection', {message: 'rejected'});
		expect(doubles.logger.error).toHaveBeenNthCalledWith(2, 'unhandled_rejection', {message: 'plain reason'});
		expect(exitCodes).toStrictEqual([1, 1]);
	});

	it('passes no worker entry when none is configured', () => {
		start();

		expect(doubles.createCodeIndex).toHaveBeenCalledWith(config, doubles.database, doubles.logger, {analytics: doubles.analytics});
	});
});
