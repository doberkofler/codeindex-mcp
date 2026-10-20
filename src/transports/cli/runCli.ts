import {Command} from 'commander';
import {createAnalyticsRecorder} from '../../core/analytics/recorder.ts';
import {addBenchmarkCommand} from '../../core/benchmark/runBenchmark.ts';
import {addBenchmarkSuiteCommand} from '../../core/benchmark/suite.ts';
import {addBenchmarkPrepareCommand} from '../../core/benchmark/suitePrepare.ts';
import {loadConfig} from '../../core/config/config.ts';
import {isCodeIndexError} from '../../core/errors/errors.ts';
import {createCodeIndex, type CodeIndex, type CodeIndexOptionsType} from '../../core/generation/codeIndex.ts';
import {debugFor, enableDebug} from '../../core/logging/debug.ts';
import {createLogger} from '../../core/logging/logger.ts';
import {type BuildReportType, type IndexStatusType, type IndexVerificationType} from '../../core/model.ts';
import {addPublicationReportCommand} from '../../core/qualification/publication/publicationCommand.ts';
import {addQualifyCommand, addVerifyReferencesCommand} from '../../core/qualification/qualifyCommand.ts';
import {IndexDatabase} from '../../core/storage/database.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../../core/version.ts';
import {readVcsProvenance} from '../../adapters/vcs/vcsProvenance.ts';
import {addAnalyticsCommand} from './analyticsCommand.ts';
import {messageOf, parseCommandAsync} from './commanderSupport.ts';
import {addOracleLiveCommand} from './oracleLiveCommand.ts';

const debug = debugFor('cli');
const BANNER_COMMANDS: ReadonlySet<string> = new Set(['update', 'refresh', 'rebuild', 'status', 'verify']);

export type CliIoType = Readonly<{
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}>;

type CommonOptionsType = Readonly<{
	readonly json?: boolean | undefined;
	readonly debug?: boolean | undefined;
	readonly config?: string | undefined;
	readonly root?: string | undefined;
	readonly extractor?: string | undefined;
	readonly projectFile?: string | undefined;
	readonly database?: string | undefined;
}>;

type CliContextType = Readonly<{
	readonly environment: NodeJS.ProcessEnv;
	readonly io: CliIoType;
	readonly workerEntry?: string;
}>;

const writeJson = (value: unknown, io: CliIoType): void => {
	io.stdout(JSON.stringify(value, null, 2));
};

const formatBuildReport = (report: BuildReportType): readonly string[] => [
	report.reused ? `Index already up to date: ${report.generationId}` : `Index rebuilt: ${report.generationId}`,
	`  duration: ${report.durationMs} ms`,
	`  files: ${report.fileCount}`,
	`  symbols: ${report.symbolCount}`,
	`  occurrences: ${report.occurrenceCount}`,
	`  dependency edges: ${report.dependencyEdgeCount}`,
	`  dependency bindings: ${report.dependencyBindingCount}`,
	`  diagnostics: ${report.diagnosticCount}`,
];

const formatStatus = (status: IndexStatusType): readonly string[] => [
	`state: ${status.state}${status.building ? ' (building)' : ''}`,
	`refresh: ${status.refresh}`,
	`freshness: ${status.freshness.state} (${status.freshness.dirtyFileCount ?? 'project-wide'} dirty)`,
	`generation: ${status.generationId ?? 'none'}`,
	`working copy: ${status.scope.workingCopyId ?? 'unavailable'}`,
	`project: ${status.scope.projectName} (${status.scope.projectId})`,
	`root: ${status.scope.root}`,
	`project file: ${status.scope.projectFile}`,
	`extractor: ${status.scope.extractor.id} ${status.scope.extractor.version} (compiler ${status.scope.extractor.compilerVersion})`,
	`files: ${status.counts.files}`,
	`symbols: ${status.counts.symbols}`,
	`occurrences: ${status.counts.occurrences}`,
	`dependency edges: ${status.counts.dependencyEdges}`,
	`dependency bindings: ${status.counts.dependencyBindings}`,
	`diagnostics: ${status.counts.diagnostics}`,
	`stale files: ${status.freshness.staleFiles}`,
	`source changed: ${status.freshness.sourceChanged === null ? 'unknown' : String(status.freshness.sourceChanged)}`,
	`build stages: ${status.build.stages === null ? 'none' : JSON.stringify(status.build.stages)}`,
	`lease: ${status.lease === null ? 'none' : `${status.lease.ownerId} until ${status.lease.expiresAt}`}`,
	`last error: ${status.lastError ?? 'none'}`,
];

const formatVerification = (verification: IndexVerificationType): readonly string[] => [
	`integrity: ${verification.integrity}`,
	`generation: ${verification.generationId}`,
	`metadata counts: ${verification.metadataMatches ? 'match' : 'mismatch'}`,
	`files: ${verification.counts.files}`,
	`symbols: ${verification.counts.symbols}`,
	`occurrences: ${verification.counts.occurrences}`,
	`dependency edges: ${verification.counts.dependencyEdges}`,
	`dependency bindings: ${verification.counts.dependencyBindings}`,
	`diagnostics: ${verification.counts.diagnostics}`,
];

const writeResult = (value: unknown, json: boolean, format: () => readonly string[], io: CliIoType): void => {
	if (json) {
		writeJson(value, io);
		return;
	}

	io.stdout(format().join('\n'));
};

const toOverrides = (options: CommonOptionsType): Readonly<Record<string, string>> => {
	const overrides: Record<string, string> = {};
	const assignments: readonly (readonly [string, string | undefined])[] = [
		['CODE_INDEX_CONFIG', options.config],
		['CODE_INDEX_ROOT', options.root],
		['CODE_INDEX_EXTRACTOR', options.extractor],
		['CODE_INDEX_PROJECT_FILE', options.projectFile],
		['CODE_INDEX_DATABASE', options.database],
	];

	for (const [name, value] of assignments) {
		if (value !== undefined) {
			overrides[name] = value;
		}
	}

	return overrides;
};

const withIndex = async (
	context: CliContextType,
	options: CommonOptionsType,
	action: (index: CodeIndex, json: boolean) => void | Promise<void>,
): Promise<void> => {
	if (options.debug === true) {
		enableDebug();
		debug('debug tracing enabled');
	}

	const config = loadConfig({...context.environment, ...toOverrides(options)});
	debug('command starting', {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		extractorId: config.extractorId,
		databasePath: config.databasePath,
		json: options.json === true,
	});
	const logger = createLogger({minimumLevel: config.logLevel});
	const database = IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		extractorId: config.extractorId,
		projectId: config.projectId,
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
	const index = createCodeIndex(config, database, logger, {
		...(context.workerEntry === undefined ? {} : {workerEntry: context.workerEntry}),
		analytics,
		watch: false,
	});

	try {
		await action(index, options.json === true);
	} finally {
		await index.close();
	}
};

const addCommonOptions = (command: Command): Command =>
	command
		.option('--json', 'emit machine-readable JSON')
		.option('--debug', 'enable codeindex:* trace output')
		.option('--config <path>', 'load a JSON configuration file')
		.option('--root <path>', 'override the indexed workspace root')
		.option('--extractor <id>', 'override the selected extractor')
		.option('--project-file <path>', 'override the extractor project file')
		.option('--database <path>', 'override the index database path');

const buildProgram = (context: CliContextType): Command => {
	const program = new Command();

	program
		.name('codeindex-cli')
		.description('Operational commands for the local code index; use "mcp install|uninstall" to manage the project-local OpenCode server')
		.usage('<command> [options]')
		.exitOverride()
		.showHelpAfterError()
		.configureOutput({
			writeOut: (text) => {
				context.io.stdout(text.trimEnd());
			},
			writeErr: (text) => {
				context.io.stderr(text.trimEnd());
			},
		})
		.hook('preAction', (_thisCommand, actionCommand) => {
			if (!BANNER_COMMANDS.has(actionCommand.name())) {
				return;
			}

			const options = actionCommand.opts<CommonOptionsType>();

			if (options.json !== true) {
				context.io.stdout(`${PROGRAM_NAME} ${PROGRAM_VERSION} (${actionCommand.name()})`);
			}
		});

	addCommonOptions(
		program
			.command('update')
			.description('Rebuild only when source or configuration changed')
			.action(async (options: CommonOptionsType) => {
				await withIndex(context, options, async (index, json) => {
					const report = await index.ensureReady();
					writeResult(report, json, () => formatBuildReport(report), context.io);
				});
			}),
	);

	addCommonOptions(
		program
			.command('refresh')
			.description('Alias for update: rebuild only when something changed')
			.action(async (options: CommonOptionsType) => {
				await withIndex(context, options, async (index, json) => {
					const report = await index.ensureReady();
					writeResult(report, json, () => formatBuildReport(report), context.io);
				});
			}),
	);

	addCommonOptions(
		program
			.command('rebuild')
			.description('Force a new generation even when nothing changed')
			.action(async (options: CommonOptionsType) => {
				await withIndex(context, options, async (index, json) => {
					const report = await index.ensureReady({force: true});
					writeResult(report, json, () => formatBuildReport(report), context.io);
				});
			}),
	);

	addCommonOptions(
		program
			.command('status')
			.description('Show generation, counts, and freshness')
			.action(async (options: CommonOptionsType) => {
				await withIndex(context, options, (index, json) => {
					const status = index.getStatus();
					writeResult(status, json, () => formatStatus(status), context.io);
				});
			}),
	);

	addCommonOptions(
		program
			.command('verify')
			.description('Check SQLite integrity and persisted row counts')
			.action(async (options: CommonOptionsType) => {
				await withIndex(context, options, (index, json) => {
					const verification = index.verify();
					writeResult(verification, json, () => formatVerification(verification), context.io);
				});
			}),
	);

	addAnalyticsCommand(program, context.environment, context.io);
	addBenchmarkCommand(program, context.environment, context.io);
	addBenchmarkSuiteCommand(program, context.environment, context.io, {cliPath: process.argv[1] ?? ''});
	addBenchmarkPrepareCommand(program, context.io);
	addQualifyCommand(program, context.environment, context.io);
	addPublicationReportCommand(program, context.environment, context.io);
	addOracleLiveCommand(program, context.environment, context.io);
	addVerifyReferencesCommand(program, context.environment, context.io);

	return program;
};

const formatCommandError = (error: unknown): string => (isCodeIndexError(error) ? `${error.code}: ${error.message}` : messageOf(error));

/**
 * Runs one operational command against a real working copy.
 *
 * Commander owns argument parsing, subcommand help, and usage errors. The CLI
 * emits status to stdout and diagnostics to stderr; it never touches the MCP
 * transport.
 *
 * @param argv - Arguments after the executable name.
 * @param environment - Environment source validated by `loadConfig`.
 * @param io - Output sinks used by tests.
 * @param options - Runtime injection points, including the bundled worker entry.
 * @returns Process exit code.
 */
export const runCli = async (argv: readonly string[], environment: NodeJS.ProcessEnv, io: CliIoType, options: CodeIndexOptionsType = {}): Promise<number> => {
	const program = buildProgram({environment, io, ...options});
	debug('cli start', {argv: [...argv]});

	if (argv.length === 0) {
		io.stdout(program.helpInformation().trimEnd());
		return 0;
	}

	const code = await parseCommandAsync(program, argv, io, {usageExitCode: 2, formatError: formatCommandError});
	debug('cli complete', {result: code});
	return code;
};
