import path from 'node:path';
import {parseArgs} from 'node:util';
import {type BenchmarkProfileType, type BenchmarkScenarioNameType} from './benchTypes.ts';
import {isBenchmarkProfile} from './corpus.ts';

const {join} = path;
const DEFAULT_SCENARIOS: readonly BenchmarkScenarioNameType[] = ['cold_build', 'warm_reuse', 'warm_rebuild', 'deep_cursor'];

export const benchmarkUsage = `Usage: codeindex-cli benchmark [options]

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
  --keep-workspace       Retain generated workspace and temporary database
  --baseline <path>      Versioned gate configuration
  --reference <path>     Accepted report for relative regression gates
  --evaluation <path>    Evaluation JSON sidecar (default beside the report)
  --summary <path>       Markdown summary, for example GITHUB_STEP_SUMMARY
  --output <path>        Write JSON results to this path
  --config <path>        Load a JSON configuration file
  --root <path>          Measure an external indexed workspace
  --extractor <id>       Override the selected extractor
  --project-file <path>  Override the extractor project file
  --database <path>      Override the benchmark database path
  --help                 Print this message

Edit-to-fresh mutates source and is allowed only for a generated corpus.
`;

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

export type BenchmarkOptionValuesType = Readonly<Record<string, string | boolean | undefined>>;

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

export type BenchmarkOptionsType = Readonly<{
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

	if (values['reference'] !== undefined && values['baseline'] === undefined) {
		throw new Error('--reference requires --baseline');
	}

	if (values['evaluation'] !== undefined && values['baseline'] === undefined) {
		throw new Error('--evaluation requires --baseline');
	}
};

export const parseBenchmarkOptions = (values: BenchmarkOptionValuesType): BenchmarkOptionsType => {
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

export const parseBenchmarkArgs = (argv: readonly string[]): BenchmarkOptionValuesType => {
	const separator = argv.indexOf('--');
	const args = separator === -1 ? [...argv] : [...argv.slice(0, separator), ...argv.slice(separator + 1)];
	const {values} = parseArgs({
		args,
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
			baseline: {type: 'string'},
			reference: {type: 'string'},
			evaluation: {type: 'string'},
			summary: {type: 'string'},
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

	return values;
};
