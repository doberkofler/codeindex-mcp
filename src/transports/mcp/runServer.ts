import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {loadConfiguredAdapters} from '../../adapters/loader.ts';
import {readVcsProvenance} from '../../adapters/vcs/vcsProvenance.ts';
import {createAnalyticsRecorder, type AnalyticsRecorderType} from '../../core/analytics/recorder.ts';
import {configuredAdapters, loadConfig} from '../../core/config/config.ts';
import {createCodeIndex, type CodeIndex, type CodeIndexOptionsType} from '../../core/generation/codeIndex.ts';
import {buildWorkerOf} from '../../core/generation/buildWorkerSetup.ts';
import {createLogger, type LoggerType} from '../../core/logging/logger.ts';
import {buildMcpServer} from './buildMcpServer.ts';
import {SCHEMA_VERSION} from '../../core/storage/schema.ts';
import {IndexDatabase} from '../../core/storage/database.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../../core/version.ts';

const installShutdownHandlers = (
	input: Readonly<{
		handle: Readonly<{close: () => Promise<void>}>;
		index: CodeIndex;
		logger: LoggerType;
		analytics: AnalyticsRecorderType;
	}>,
): void => {
	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) {
			return;
		}

		shuttingDown = true;
		input.logger.info('code_index_stopping', {signal});
		input.analytics.record('process_stop', {signal});

		void (async (): Promise<void> => {
			try {
				await input.handle.close();
			} catch (error) {
				input.logger.error('code_index_close_failed', {message: error instanceof Error ? error.message : String(error)});
			}

			await input.index.close();
			process.exit(0);
		})();
	};

	process.on('SIGINT', () => {
		shutdown('SIGINT');
	});
	process.on('SIGTERM', () => {
		shutdown('SIGTERM');
	});
	process.on('uncaughtException', (error) => {
		input.logger.error('uncaught_exception', {message: error.message, stack: error.stack ?? null});
		process.exit(1);
	});
	process.on('unhandledRejection', (reason) => {
		input.logger.error('unhandled_rejection', {message: reason instanceof Error ? reason.message : String(reason)});
		process.exit(1);
	});
};

/**
 * Starts the local stdio MCP server.
 *
 * Stdout is reserved for MCP framing; every diagnostic is written to stderr.
 *
 * @param options - Runtime injection points; the bundled entry passes its own
 * executable as the background worker entry.
 */
export const run = async (options: CodeIndexOptionsType = {}): Promise<void> => {
	process.stderr.write(`${PROGRAM_NAME} ${PROGRAM_VERSION}\n`);
	const config = loadConfig(process.env);
	const logger = createLogger({minimumLevel: config.logLevel});
	const vcs = readVcsProvenance(config.rootDir);
	const databaseContext = {
		rootDir: config.rootDir,
		projectId: config.projectId,
		projects: configuredAdapters(config).map((adapter) => ({
			adapterId: adapter.id,
			projectId: config.projectId,
			projectFilePath: adapter.projectFilePath,
		})),
		vcs,
	} as const;
	const adapterSet = await loadConfiguredAdapters(config);
	const workerSelection = buildWorkerOf(config, options, adapterSet);

	if (workerSelection.worker !== null) {
		try {
			await workerSelection.worker.initialize(config, databaseContext);
		} catch (error) {
			await workerSelection.worker.close();
			throw error;
		}
	}

	const database =
		workerSelection.worker === null
			? IndexDatabase.open(config.databasePath, databaseContext)
			: IndexDatabase.openReadOnly(config.databasePath, databaseContext);
	const workingCopy = database.getWorkingCopy();
	const analytics = createAnalyticsRecorder({
		enabled: config.analyticsEnabled,
		path: config.analyticsPath,
		projectId: config.projectId,
		program: PROGRAM_NAME,
		programVersion: PROGRAM_VERSION,
		workingCopyId: workingCopy?.id ?? null,
	});
	const index = createCodeIndex(config, database, logger, {
		...options,
		...(workerSelection.worker === null ? {} : {buildWorker: workerSelection.worker}),
		analytics,
		adapters: adapterSet.adapters,
		adapterDescriptors: adapterSet.descriptors,
	});
	const discoveryText = configuredAdapters(config)
		.map((adapter) => adapterSet.byId.get(adapter.id)?.discoveryText ?? '')
		.filter((text) => text.length > 0)
		.join('\n\n');

	logger.info('code_index_starting', {
		version: PROGRAM_VERSION,
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		extractorId: config.extractorId,
		databasePath: config.databasePath,
		projectId: config.projectId,
		workingCopyId: workingCopy?.id ?? null,
		analyticsEnabled: analytics.enabled,
		maxResultBytes: config.maxResultBytes,
		maxReadLines: config.maxReadLines,
	});
	analytics.record('process_start', {
		nodeVersion: process.version,
		schemaVersion: SCHEMA_VERSION,
		analyticsEnabled: analytics.enabled,
	});

	const handle = serveStdio(() =>
		buildMcpServer({
			index,
			logger,
			analytics,
			maxResultBytes: config.maxResultBytes,
			extractorDiscoveryText: discoveryText,
		}),
	);

	index.start();
	installShutdownHandlers({handle, index, logger, analytics});
};
