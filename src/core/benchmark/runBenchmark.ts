import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {type ConfigType, loadConfig} from '../config/config.ts';
import {createCodeIndex} from '../generation/codeIndex.ts';
import {createLogger} from '../logging/logger.ts';
import {IndexDatabase} from '../storage/database.ts';
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
import {createBenchmarkCorpus, hasBenchmarkProject, isBenchmarkProfile} from './corpus.ts';
import {runCursorScenario} from './cursorScenario.ts';
import {runEditScenario} from './editScenario.ts';
import {measureQueries, summarizeQueries} from './queries.ts';

const {join} = path;
const LOGGER = createLogger({minimumLevel: 'error'});
const DEFAULT_SCENARIOS: readonly BenchmarkScenarioNameType[] = ['cold_build', 'warm_reuse', 'warm_rebuild', 'deep_cursor'];

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
		const outlinePath = files.find((file) => file.path.endsWith('outline.ts'))?.path ?? files.at(0)?.path;

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
	readonly maxDepth?: number;
	readonly pageLimit?: number;
	readonly workerEntry?: string | undefined;
}>;

const runInitialBuild = async (
	input: BenchmarkReportInputType,
	selected: ReadonlySet<BenchmarkScenarioNameType>,
	workerEntry: string | undefined,
): Promise<BenchmarkScenarioResultType> => {
	if (selected.has('cold_build') || !existsSync(input.config.databasePath)) {
		removeDatabase(input.config.databasePath);
		const report = await runBuildScenario({config: input.config, name: 'cold_build', force: false, workerEntry});
		return report;
	}

	const report = await runBuildScenario({config: input.config, name: input.force ? 'warm_rebuild' : 'warm_reuse', force: input.force, workerEntry});
	return report;
};

const runOptionalScenarios = async (
	input: BenchmarkReportInputType,
	selected: ReadonlySet<BenchmarkScenarioNameType>,
	workerEntry: string | undefined,
): Promise<readonly BenchmarkScenarioResultType[]> => {
	const results: BenchmarkScenarioResultType[] = [];

	if (selected.has('warm_reuse') && selected.has('cold_build')) {
		results.push(await runBuildScenario({config: input.config, name: 'warm_reuse', force: false, workerEntry}));
	}

	if (selected.has('warm_rebuild') && !input.force) {
		results.push(await runBuildScenario({config: input.config, name: 'warm_rebuild', force: true, workerEntry}));
	}

	if (selected.has('edit_to_fresh')) {
		results.push(await runEditScenario({config: input.config, rounds: input.editRounds ?? 5, workerEntry}));
	}

	if (selected.has('deep_cursor')) {
		results.push(await runCursorScenario({config: input.config, maxDepth: input.maxDepth, pageLimit: input.pageLimit, workerEntry}));
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
	const measured = await measureQueryScenario(input.config, input.iterations, workerEntry);

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

const usage = `Usage: codeindex-cli benchmark [options]

Measures local build, edit-to-fresh, resource, storage, and query behavior.
Performs no model calls. Cold builds use a temporary database.

Options:
  --profile <name>       Generate a corpus: small, medium, large, or xl
  --workspace <path>     Destination or existing corpus for --profile
  --scenarios <list>     Comma-separated: cold, warm, rebuild, edit, deep, queries
  --iterations <n>       Query iterations (default 20)
  --edit-rounds <n>      One-file edits measured (default 5)
  --max-depth <n>        Deep cursor maximum offset (default 10000)
  --page-limit <n>       Deep cursor page size (default 200)
  --rebuild              Alias for the warm rebuild scenario
  --keep-workspace       Retain generated workspace and database
  --output <path>        Write JSON results to this path
  --config <path>        Load a JSON configuration file
  --root <path>          Measure an external indexed workspace
  --extractor <id>       Override the selected extractor
  --project-file <path>  Override the extractor project file
  --database <path>      Override the benchmark database path
  --help                 Print this message

Edit-to-fresh mutates source and is allowed only for a generated corpus.
`;

export type BenchmarkIoType = Readonly<{
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}>;

const scenarioMap: Readonly<Record<string, BenchmarkScenarioNameType>> = {
	cold: 'cold_build',
	warm: 'warm_reuse',
	rebuild: 'warm_rebuild',
	edit: 'edit_to_fresh',
	deep: 'deep_cursor',
};

const parseScenarios = (value: string | undefined, rebuild: boolean): readonly BenchmarkScenarioNameType[] => {
	const selected = new Set<BenchmarkScenarioNameType>(value === undefined ? DEFAULT_SCENARIOS : []);
	const names =
		value
			?.split(',')
			.map((name) => name.trim())
			.filter((name) => name.length > 0) ?? [];

	for (const name of names) {
		if (name === 'queries') {
			continue;
		}

		const scenario = scenarioMap[name];

		if (scenario === undefined) {
			throw new Error(`Unknown scenario: ${name}`);
		}

		selected.add(scenario);
	}

	if (rebuild) {
		selected.add('warm_rebuild');
	}

	return [...selected];
};

type BenchmarkOptionValuesType = Readonly<Record<string, string | boolean | undefined>>;

const prepareEnvironment = (
	input: Readonly<{
		values: BenchmarkOptionValuesType;
		environment: NodeJS.ProcessEnv;
		profile: BenchmarkProfileType | null;
		workspaceRoot: string | null;
		databasePath: string;
	}>,
): NodeJS.ProcessEnv => {
	const overrides: NodeJS.ProcessEnv = {CODE_INDEX_ANALYTICS: 'false', CODE_INDEX_DATABASE: input.databasePath};
	const {values} = input;

	if (input.profile !== null && input.workspaceRoot !== null) {
		overrides['CODE_INDEX_ROOT'] = input.workspaceRoot;
		overrides['CODE_INDEX_PROJECT_FILE'] = join(input.workspaceRoot, 'tsconfig.json');
	} else if (typeof values['root'] === 'string') {
		overrides['CODE_INDEX_ROOT'] = values['root'];
	}

	for (const [name, value] of [
		['CODE_INDEX_EXTRACTOR', values['extractor']],
		['CODE_INDEX_PROJECT_FILE', values['project-file']],
	] as const) {
		if (typeof value === 'string') {
			overrides[name] = value;
		}
	}

	return {...input.environment, ...overrides, ...(typeof values['config'] === 'string' ? {CODE_INDEX_CONFIG: values['config']} : {})};
};

const prepareWorkspace = (
	input: Readonly<{
		profile: BenchmarkProfileType | null;
		workspace: string | undefined;
	}>,
): Readonly<{workspaceRoot: string | null; temporaryWorkspace: string | null}> => {
	if (input.profile === null) {
		return {workspaceRoot: null, temporaryWorkspace: null};
	}

	const workspaceRoot = input.workspace === undefined ? mkdtempSync(join(os.tmpdir(), 'codeindex-benchmark-workspace-')) : path.resolve(input.workspace);

	if (!hasBenchmarkProject(workspaceRoot)) {
		if (existsSync(workspaceRoot) && readdirSync(workspaceRoot).length > 0) {
			throw new Error('--workspace must be empty or contain a benchmark tsconfig.json');
		}

		createBenchmarkCorpus({directory: workspaceRoot, profile: input.profile});
	}

	return {workspaceRoot, temporaryWorkspace: input.workspace === undefined ? workspaceRoot : null};
};

type BenchmarkOptionsType = Readonly<{
	profile: BenchmarkProfileType | null;
	scenarios: readonly BenchmarkScenarioNameType[];
	iterations: number;
	editRounds: number;
	maxDepth: number;
	pageLimit: number;
}>;

const numericOptions = (values: BenchmarkOptionValuesType): Readonly<{iterations: number; editRounds: number; maxDepth: number; pageLimit: number}> => {
	const options = {
		iterations: Number(values['iterations']),
		editRounds: Number(values['edit-rounds']),
		maxDepth: Number(values['max-depth']),
		pageLimit: Number(values['page-limit']),
	};

	for (const [name, value, maximum] of [
		['--iterations', options.iterations, 10_000],
		['--edit-rounds', options.editRounds, 1000],
		['--max-depth', options.maxDepth, 10_000_000],
		['--page-limit', options.pageLimit, 10_000],
	] as const) {
		if (!Number.isInteger(value) || value < 1 || value > maximum) {
			throw new Error(`${name} must be an integer between 1 and ${String(maximum)}`);
		}
	}

	return options;
};

const validateScenarios = (profile: BenchmarkProfileType | null, scenarios: readonly BenchmarkScenarioNameType[], values: BenchmarkOptionValuesType): void => {
	if (profile === null && values['workspace'] !== undefined) {
		throw new Error('--workspace requires --profile');
	}

	if (profile === null && scenarios.includes('edit_to_fresh')) {
		throw new Error('edit-to-fresh requires a generated corpus; pass --profile');
	}

	if (values['database'] !== undefined && (scenarios.includes('cold_build') || scenarios.includes('warm_rebuild'))) {
		throw new Error('cold and rebuild scenarios require a disposable database; omit --database');
	}
};

const parseBenchmarkOptions = (values: BenchmarkOptionValuesType): BenchmarkOptionsType => {
	const profileValue = values['profile'];

	if (typeof profileValue === 'string' && !isBenchmarkProfile(profileValue)) {
		throw new Error('--profile must be one of: small, medium, large, xl');
	}

	const profile = typeof profileValue === 'string' ? profileValue : null;
	const scenarios = parseScenarios(typeof values['scenarios'] === 'string' ? values['scenarios'] : undefined, values['rebuild'] === true);
	const numbers = numericOptions(values);
	validateScenarios(profile, scenarios, values);

	return {profile, scenarios, ...numbers};
};

const writeReport = (input: Readonly<{report: BenchmarkReportType; output: string | undefined; io: BenchmarkIoType}>): string => {
	const outputPath = input.output ?? join(process.cwd(), 'benchmark', 'results', `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);

	mkdirSync(path.dirname(outputPath), {recursive: true});
	writeFileSync(outputPath, `${JSON.stringify(input.report, null, 2)}\n`, {encoding: 'utf8'});
	input.io.stdout(`Benchmark written to ${outputPath}`);
	input.io.stdout(
		JSON.stringify({scenarios: input.report.scenarios.map((scenario) => ({name: scenario.name, kind: scenario.kind})), queries: input.report.queries}, null, 2),
	);
	return outputPath;
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
	const cleanup: string[] = [];

	try {
		const parsed = parseArgs({
			args: [...argv],
			options: {
				iterations: {type: 'string', default: '20'},
				'edit-rounds': {type: 'string', default: '5'},
				'max-depth': {type: 'string', default: '10000'},
				'page-limit': {type: 'string', default: '200'},
				rebuild: {type: 'boolean', default: false},
				'keep-workspace': {type: 'boolean', default: false},
				profile: {type: 'string'},
				workspace: {type: 'string'},
				scenarios: {type: 'string'},
				output: {type: 'string'},
				config: {type: 'string'},
				root: {type: 'string'},
				extractor: {type: 'string'},
				'project-file': {type: 'string'},
				database: {type: 'string'},
				help: {type: 'boolean', default: false},
			},
			allowPositionals: false,
		});
		const {values} = parsed;

		if (values.help) {
			io.stdout(usage.trimEnd());
			return 0;
		}

		const options = parseBenchmarkOptions(values);
		const {workspaceRoot, temporaryWorkspace} = prepareWorkspace({
			profile: options.profile,
			workspace: typeof values.workspace === 'string' ? values.workspace : undefined,
		});
		const temporaryDatabase = mkdtempSync(join(os.tmpdir(), 'codeindex-benchmark-database-'));
		cleanup.push(temporaryDatabase);

		if (temporaryWorkspace !== null) {
			cleanup.push(temporaryWorkspace);
		}

		const databasePath = typeof values.database === 'string' ? path.resolve(values.database) : join(temporaryDatabase, 'index.sqlite');
		const sourceEnvironment = prepareEnvironment({values, environment, profile: options.profile, workspaceRoot, databasePath});
		const config = {...loadConfig(sourceEnvironment), analyticsEnabled: false, databasePath};
		const report = await runBenchmarkReport({config, force: false, ...options});
		writeReport({report, output: typeof values.output === 'string' ? values.output : undefined, io});

		if (values['keep-workspace']) {
			io.stdout(`Workspace: ${workspaceRoot ?? config.rootDir}`);
			io.stdout(`Database: ${databasePath}`);
		}

		return 0;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const directory of cleanup) {
			rmSync(directory, {recursive: true, force: true});
		}
	}
};
