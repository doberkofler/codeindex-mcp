import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {extractorFor} from '../../adapters/registry.ts';
import {readVcsProvenance} from '../../adapters/vcs/vcsProvenance.ts';
import {createAnalyticsRecorder} from '../../core/analytics/recorder.ts';
import {loadConfig} from '../../core/config/config.ts';
import {createCodeIndex, type CodeIndexOptionsType} from '../../core/generation/codeIndex.ts';
import {createLogger} from '../../core/logging/logger.ts';
import {buildMcpServer} from './buildMcpServer.ts';
import {SCHEMA_VERSION} from '../../core/storage/schema.ts';
import {IndexDatabase} from '../../core/storage/database.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../../core/version.ts';

/**
 * Starts the local stdio MCP server.
 *
 * Stdout is reserved for MCP framing; every diagnostic is written to stderr.
 *
 * @param options - Runtime injection points; the bundled entry passes its own
 * executable as the background worker entry.
 */
export const run = (options: CodeIndexOptionsType = {}): void => {
	process.stderr.write(`${PROGRAM_NAME} ${PROGRAM_VERSION}\n`);
	const config = loadConfig(process.env);
	const logger = createLogger({minimumLevel: config.logLevel});
	const database = IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		extractorId: config.extractorId,
		projectId: config.projectId,
		vcs: readVcsProvenance(config.rootDir),
	});
	const workingCopy = database.getWorkingCopy();
	const analytics = createAnalyticsRecorder({
		enabled: config.analyticsEnabled,
		path: config.analyticsPath,
		projectId: config.projectId,
		program: PROGRAM_NAME,
		programVersion: PROGRAM_VERSION,
		workingCopyId: workingCopy?.id ?? null,
	});
	const index = createCodeIndex(config, database, logger, {...options, analytics});
	const extractor = extractorFor(config.extractorId);

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
			extractorDiscoveryText: extractor.discoveryText,
		}),
	);

	index.start();

	let shuttingDown = false;

	const shutdown = (signal: string): void => {
		if (shuttingDown) {
			return;
		}

		shuttingDown = true;
		logger.info('code_index_stopping', {signal});
		analytics.record('process_stop', {signal});

		void (async (): Promise<void> => {
			try {
				await handle.close();
			} catch (error) {
				logger.error('code_index_close_failed', {message: error instanceof Error ? error.message : String(error)});
			}

			await index.close();
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
		logger.error('uncaught_exception', {message: error.message, stack: error.stack ?? null});
		process.exit(1);
	});

	process.on('unhandledRejection', (reason) => {
		logger.error('unhandled_rejection', {message: reason instanceof Error ? reason.message : String(reason)});
		process.exit(1);
	});
};
