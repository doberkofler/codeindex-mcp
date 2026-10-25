import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Command} from 'commander';
import {CommandExitError, configureCommand, parseCommandAsync} from '../../transports/cli/commanderSupport.ts';
import {type ConfigType, loadConfig} from '../config/config.ts';
import {createCodeIndex} from '../generation/codeIndex.ts';
import {debugFor} from '../logging/debug.ts';
import {createLogger} from '../logging/logger.ts';
import {IndexDatabase} from '../storage/database.ts';
import {loadBenchmarkBaseline, loadBenchmarkReference} from './baseline.ts';
import {addBenchmarkOptions, type BenchmarkOptionValuesType, parseBenchmarkOptions, prepareEnvironment} from './benchmarkOptions.ts';
import {phaseOf} from './benchmarkPhase.ts';
import {
	type BenchmarkMachineType,
	type BenchmarkPercentilesType,
	type BenchmarkProfileType,
	type BenchmarkReportType,
	type BenchmarkScenarioNameType,
	type BenchmarkScenarioResultType,
	type BenchmarkWorkspaceType,
} from './benchTypes.ts';
import {runBuildScenario} from './buildScenarios.ts';
import {prepareBenchmarkWorkspace} from './corpus.ts';
import {runCursorScenario} from './cursorScenario.ts';
import {editProgressMessage, runEditScenario, type BenchmarkEditProgressType} from './editScenario.ts';
import {finalizeBenchmark, type BenchmarkIoType} from './finalize.ts';
import {measureQueries, summarizeQueries} from './queries.ts';

const {join} = path;
const LOGGER = createLogger({minimumLevel: 'error'});
const debug = debugFor('benchmark');

const machineOf = (): BenchmarkMachineType => ({
	nodeVersion: process.version,
	platform: process.platform,
	arch: process.arch,
	cpuModel: os.cpus().at(0)?.model ?? 'unknown',
	totalMemoryBytes: os.totalmem(),
});

const databaseContextOf = (config: ConfigType): Readonly<{rootDir: string; projectFilePath: string; extractorId: string; projectId: string}> => ({
	rootDir: config.rootDir,
	projectFilePath: config.projectFilePath,
	extractorId: config.extractorId,
	projectId: config.projectId,
});

const removeDatabase = (databasePath: string): void => {
	for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
		rmSync(filePath, {force: true});
	}
};

const readWorkspace = (config: ConfigType, profile: BenchmarkProfileType | null): BenchmarkWorkspaceType => {
	const database = IndexDatabase.open(config.databasePath, databaseContextOf(config));

	try {
		const published = database.getPublishedGeneration();

		if (published === null) {
			throw new Error('Benchmark did not publish a generation');
		}

		return {
			kind: profile === null ? 'external' : 'generated',
			profile,
			projectId: config.projectId,
			projectName: config.projectName,
			fileCount: published.fileCount,
			symbolCount: published.symbolCount,
			occurrenceCount: published.occurrenceCount,
			dependencyEdgeCount: published.dependencyEdgeCount,
			sourceHash: published.sourceHash,
			configHash: published.configHash,
		};
	} finally {
		database.close();
	}
};

const workerEntryOf = (): string | undefined => {
	const entry = new URL('mcp.mjs', import.meta.url);
	return existsSync(entry) ? fileURLToPath(entry) : undefined;
};

const measureQueryScenario = async (
	config: ConfigType,
	iterations: number,
	workerEntry: string | undefined,
): Promise<
	Readonly<{
		readonly queries: Readonly<Record<string, BenchmarkPercentilesType>>;
		readonly freshness: ReturnType<ReturnType<typeof createCodeIndex>['getFreshness']>;
	}>
> => {
	const database = IndexDatabase.open(config.databasePath, databaseContextOf(config));
	const index = createCodeIndex(config, database, LOGGER, {watch: false, ...(workerEntry === undefined ? {} : {workerEntry})});

	try {
		const build = await index.ensureReady();
		const files = database.listFiles(build.generationId);
		const outlinePath = database.busiestSymbolPath(build.generationId) ?? files.find((file) => file.path.endsWith('outline.ts'))?.path ?? files.at(0)?.path;

		if (outlinePath === undefined) {
			throw new Error('Benchmark requires at least one indexed file');
		}

		const sample = index.getOutline({path: outlinePath, limit: 1}).items.at(0);

		return {
			queries: summarizeQueries(measureQueries(index, outlinePath, sample, iterations)),
			freshness: index.getFreshness(),
		};
	} finally {
		await index.close();
	}
};

export type BenchmarkReportInputType = Readonly<{
	readonly config: ConfigType;
	readonly iterations: number;
	readonly force: boolean;
	readonly scenarios?: readonly BenchmarkScenarioNameType[];
	readonly profile?: BenchmarkProfileType | null;
	readonly editRounds?: number;
	readonly editTarget?: string | null;
	readonly maxDepth?: number;
	readonly pageLimit?: number;
	readonly workerEntry?: string | undefined;
	readonly onProgress?: ((progress: BenchmarkEditProgressType) => void) | undefined;
}>;

const runInitialBuild = async (
	input: BenchmarkReportInputType,
	selected: ReadonlySet<BenchmarkScenarioNameType>,
	workerEntry: string | undefined,
): Promise<BenchmarkScenarioResultType> => {
	if (selected.has('cold_build') || !existsSync(input.config.databasePath)) {
		removeDatabase(input.config.databasePath);
		const report = await phaseOf('cold_build', runBuildScenario({config: input.config, name: 'cold_build', force: false, workerEntry}));
		return report;
	}

	const name = input.force ? 'warm_rebuild' : 'warm_reuse';
	const report = await phaseOf(name, runBuildScenario({config: input.config, name, force: input.force, workerEntry}));
	return report;
};

const runOptionalScenarios = async (
	input: BenchmarkReportInputType,
	selected: ReadonlySet<BenchmarkScenarioNameType>,
	workerEntry: string | undefined,
): Promise<readonly BenchmarkScenarioResultType[]> => {
	const results: BenchmarkScenarioResultType[] = [];

	if (selected.has('warm_reuse') && selected.has('cold_build')) {
		results.push(await phaseOf('warm_reuse', runBuildScenario({config: input.config, name: 'warm_reuse', force: false, workerEntry})));
	}

	if (selected.has('warm_rebuild') && !input.force) {
		results.push(await phaseOf('warm_rebuild', runBuildScenario({config: input.config, name: 'warm_rebuild', force: true, workerEntry})));
	}

	if (selected.has('edit_to_fresh')) {
		const editTarget = input.editTarget ?? null;

		results.push(
			await phaseOf(
				'edit_to_fresh',
				runEditScenario({
					config: input.config,
					rounds: input.editRounds ?? 5,
					...(editTarget === null ? {} : {targetPath: editTarget}),
					workerEntry,
					onProgress: input.onProgress,
				}),
			),
		);
	}

	if (selected.has('deep_cursor')) {
		results.push(await phaseOf('deep_cursor', runCursorScenario({config: input.config, maxDepth: input.maxDepth, pageLimit: input.pageLimit, workerEntry})));
	}

	return results;
};

/**
 * Runs model-free build, freshness, and query measurements.
 *
 * The configured database is owned by the benchmark caller and may be removed
 * for the cold build. Never pass a production index path.
 *
 * @param input - Resolved configuration and scenario selection.
 * @returns Machine-readable benchmark results.
 * @throws {@link Error} When a build, edit, or query cannot complete.
 */
export const runBenchmarkReport = async (input: BenchmarkReportInputType): Promise<BenchmarkReportType> => {
	const selected = new Set<BenchmarkScenarioNameType>(input.scenarios ?? ['warm_reuse']);
	const workerEntry = input.workerEntry ?? workerEntryOf();
	const initial = await runInitialBuild(input, selected, workerEntry);
	const results = [initial, ...(await runOptionalScenarios(input, selected, workerEntry))];
	const measured = await phaseOf('queries', measureQueryScenario(input.config, input.iterations, workerEntry));

	return {
		schemaVersion: 2,
		generatedAt: new Date().toISOString(),
		machine: machineOf(),
		runtime: {workerEntry: workerEntry !== undefined, scenariosInProcess: true},
		workspace: readWorkspace(input.config, input.profile ?? null),
		iterations: input.iterations,
		freshness: measured.freshness,
		scenarios: results,
		queries: measured.queries,
	};
};

const prepareBenchmarkPaths = (
	input: Readonly<{
		values: BenchmarkOptionValuesType;
		profile: BenchmarkProfileType | null;
		keepWorkspace: boolean;
		cleanup: string[];
	}>,
): Readonly<{workspaceRoot: string | null; databasePath: string}> => {
	const {workspaceRoot, temporaryWorkspace} = prepareBenchmarkWorkspace({
		profile: input.profile,
		workspace: input.values.workspace,
	});
	const explicitDatabase = input.values.database === undefined ? null : path.resolve(input.values.database);
	let databasePath: string;

	if (!input.keepWorkspace && temporaryWorkspace !== null) {
		input.cleanup.push(temporaryWorkspace);
	}

	if (explicitDatabase === null) {
		const temporaryDatabase = mkdtempSync(join(os.tmpdir(), 'codeindex-benchmark-database-'));

		if (!input.keepWorkspace) {
			input.cleanup.push(temporaryDatabase);
		}

		databasePath = join(temporaryDatabase, 'index.sqlite');
	} else {
		databasePath = explicitDatabase;
	}

	return {workspaceRoot, databasePath};
};

const executeBenchmark = async (values: BenchmarkOptionValuesType, environment: NodeJS.ProcessEnv, io: BenchmarkIoType, cleanup: string[]): Promise<number> => {
	const options = parseBenchmarkOptions(values);
	const {keepWorkspace} = values;
	const loadedBaseline = values.baseline === undefined ? null : loadBenchmarkBaseline(path.resolve(values.baseline));
	const reference = values.reference === undefined ? (loadedBaseline?.reference ?? null) : loadBenchmarkReference(path.resolve(values.reference));
	const baseline = loadedBaseline === null ? null : {...loadedBaseline, reference};
	const {workspaceRoot, databasePath} = prepareBenchmarkPaths({values, profile: options.profile, keepWorkspace, cleanup});
	const sourceEnvironment = prepareEnvironment({values, environment, profile: options.profile, workspaceRoot, databasePath});
	const config = {...loadConfig(sourceEnvironment), analyticsEnabled: false, databasePath};

	try {
		const report = await runBenchmarkReport({
			config,
			force: false,
			...options,
			onProgress: (progress): void => {
				io.stderr(editProgressMessage(progress));
			},
		});

		return finalizeBenchmark({
			report,
			baseline,
			output: values.output,
			evaluationPath: values.evaluation === undefined ? undefined : path.resolve(values.evaluation),
			summaryPath: values.summary === undefined ? undefined : path.resolve(values.summary),
			io,
		});
	} finally {
		if (keepWorkspace) {
			io.stdout(`Workspace: ${workspaceRoot ?? config.rootDir}`);
			io.stdout(`Database: ${databasePath}`);
		}
	}
};

const benchmarkCommand = (environment: NodeJS.ProcessEnv, io: BenchmarkIoType): Command => {
	const cleanup: string[] = [];

	return addBenchmarkOptions(
		configureCommand(new Command('benchmark').description('Measure local build, edit-to-fresh, resource, storage, and query behavior'), io),
	).action(async (values: BenchmarkOptionValuesType) => {
		try {
			const code = await executeBenchmark(values, environment, io, cleanup);

			if (code !== 0) {
				throw new CommandExitError(code);
			}
		} catch (error) {
			debug('benchmark failed', {error: error instanceof Error ? error.stack : String(error)});
			throw error;
		} finally {
			for (const directory of cleanup) {
				rmSync(directory, {recursive: true, force: true});
			}
		}
	});
};

/**
 * Registers the local benchmark command.
 *
 * @param program - Root CLI program.
 * @param environment - Environment validated by `loadConfig`.
 * @param io - Output sinks.
 */
export const addBenchmarkCommand = (program: Command, environment: NodeJS.ProcessEnv, io: BenchmarkIoType): void => {
	program.addCommand(benchmarkCommand(environment, io));
};

/**
 * Runs the local benchmark command.
 *
 * @param argv - Arguments after the `benchmark` command.
 * @param environment - Environment validated by `loadConfig`.
 * @param io - Output sinks used by tests.
 * @returns Process exit code.
 */
export const runBenchmarkCommand = async (argv: readonly string[], environment: NodeJS.ProcessEnv, io: BenchmarkIoType): Promise<number> => {
	const program = new Command('codeindex-cli');
	program.addCommand(benchmarkCommand(environment, io));
	const code = await parseCommandAsync(program, ['benchmark', ...argv], io, {usageExitCode: 1});

	return code;
};
