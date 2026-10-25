import path from 'node:path';
import {type Command} from 'commander';
import {type BenchmarkProfileType, type BenchmarkScenarioNameType} from './benchTypes.ts';
import {isBenchmarkProfile} from './corpus.ts';

const {join} = path;
const DEFAULT_SCENARIOS: readonly BenchmarkScenarioNameType[] = ['cold_build', 'warm_reuse', 'warm_rebuild', 'deep_cursor'];

/**
 * Adds the benchmark flags to a Commander command.
 *
 * @param command - Command to extend.
 * @returns The same command with benchmark options.
 */
export const addBenchmarkOptions = (command: Command): Command =>
	command
		.option('--profile <name>', 'generate a corpus: small, medium, large, or xl')
		.option('--workspace <path>', 'destination or existing corpus for --profile')
		.option('--scenarios <list>', 'comma-separated: cold, warm, rebuild, edit, deep, queries')
		.option('--iterations <n>', 'query iterations', '20')
		.option('--edit-rounds <n>', 'one-file edits measured', '5')
		.option('--edit-target <path>', 'workspace-relative source file changed by edit-to-fresh')
		.option('--disposable', 'acknowledge that --root, the database, and edited source are disposable')
		.option('--max-depth <n>', 'deep cursor maximum offset', '10000')
		.option('--page-limit <n>', 'deep cursor page size', '200')
		.option('--rebuild', 'alias for the warm rebuild scenario')
		.option('--keep-workspace', 'retain generated workspace and temporary database')
		.option('--baseline <path>', 'versioned gate configuration')
		.option('--reference <path>', 'accepted report for relative regression gates')
		.option('--evaluation <path>', 'evaluation JSON sidecar (default beside the report)')
		.option('--summary <path>', 'markdown summary, for example GITHUB_STEP_SUMMARY')
		.option('--output <path>', 'write JSON results to this path')
		.option('--config <path>', 'load a JSON configuration file')
		.option('--root <path>', 'measure an external indexed workspace')
		.option('--extractor <id>', 'override the selected extractor')
		.option('--project-file <path>', 'override the extractor project file')
		.option('--database <path>', 'override the benchmark database path');

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

export type BenchmarkOptionValuesType = Readonly<{
	profile?: string | undefined;
	workspace?: string | undefined;
	scenarios?: string | undefined;
	iterations: string;
	editRounds: string;
	editTarget?: string | undefined;
	disposable: boolean;
	maxDepth: string;
	pageLimit: string;
	rebuild: boolean;
	keepWorkspace: boolean;
	baseline?: string | undefined;
	reference?: string | undefined;
	evaluation?: string | undefined;
	summary?: string | undefined;
	output?: string | undefined;
	config?: string | undefined;
	root?: string | undefined;
	extractor?: string | undefined;
	projectFile?: string | undefined;
	database?: string | undefined;
}>;

export const prepareEnvironment = (
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
	} else if (values.root !== undefined) {
		overrides['CODE_INDEX_ROOT'] = values.root;
	}

	for (const [name, value] of [
		['CODE_INDEX_EXTRACTOR', values.extractor],
		['CODE_INDEX_PROJECT_FILE', values.projectFile],
	] as const) {
		if (value !== undefined) {
			overrides[name] = value;
		}
	}

	return {...input.environment, ...overrides, ...(values.config === undefined ? {} : {CODE_INDEX_CONFIG: values.config})};
};

export type BenchmarkOptionsType = Readonly<{
	profile: BenchmarkProfileType | null;
	scenarios: readonly BenchmarkScenarioNameType[];
	iterations: number;
	editRounds: number;
	editTarget: string | null;
	maxDepth: number;
	pageLimit: number;
}>;

const numericOptions = (values: BenchmarkOptionValuesType): Readonly<{iterations: number; editRounds: number; maxDepth: number; pageLimit: number}> => {
	const options = {
		iterations: Number(values.iterations),
		editRounds: Number(values.editRounds),
		maxDepth: Number(values.maxDepth),
		pageLimit: Number(values.pageLimit),
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

const parseEditTarget = (value: string | undefined): string | null => {
	if (value === undefined) {
		return null;
	}

	const normalized = path.posix.normalize(value.replaceAll('\\', '/'));

	if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) {
		throw new Error('--edit-target must be a workspace-relative source path');
	}

	return normalized;
};

const validateEditScenario = (
	profile: BenchmarkProfileType | null,
	scenarios: readonly BenchmarkScenarioNameType[],
	values: BenchmarkOptionValuesType,
): void => {
	if (profile !== null || !scenarios.includes('edit_to_fresh')) {
		return;
	}

	if (values.root === undefined) {
		throw new Error('edit-to-fresh requires a generated corpus or --root');
	}

	if (values.editTarget === undefined) {
		throw new Error('edit-to-fresh with --root requires --edit-target');
	}

	if (!values.disposable) {
		throw new Error('edit-to-fresh mutates its workspace; pass --disposable only for a disposable --root copy');
	}
};

const validateDatabase = (scenarios: readonly BenchmarkScenarioNameType[], values: BenchmarkOptionValuesType): void => {
	const requiresDisposableDatabase = scenarios.includes('cold_build') || scenarios.includes('warm_rebuild');

	if (values.database !== undefined && requiresDisposableDatabase && !values.disposable) {
		throw new Error('cold and rebuild scenarios require a disposable database; omit --database or pass --disposable');
	}
};

const validateScenarios = (profile: BenchmarkProfileType | null, scenarios: readonly BenchmarkScenarioNameType[], values: BenchmarkOptionValuesType): void => {
	if (profile === null && values.workspace !== undefined) {
		throw new Error('--workspace requires --profile');
	}

	validateEditScenario(profile, scenarios, values);
	validateDatabase(scenarios, values);

	if (values.reference !== undefined && values.baseline === undefined) {
		throw new Error('--reference requires --baseline');
	}

	if (values.evaluation !== undefined && values.baseline === undefined) {
		throw new Error('--evaluation requires --baseline');
	}
};

export const parseBenchmarkOptions = (values: BenchmarkOptionValuesType): BenchmarkOptionsType => {
	const profileValue = values.profile;

	if (profileValue !== undefined && !isBenchmarkProfile(profileValue)) {
		throw new Error('--profile must be one of: small, medium, large, xl');
	}

	const profile = profileValue ?? null;
	const scenarios = parseScenarios(values.scenarios, values.rebuild);
	const numbers = numericOptions(values);
	validateScenarios(profile, scenarios, values);

	return {profile, scenarios, editTarget: parseEditTarget(values.editTarget), ...numbers};
};
