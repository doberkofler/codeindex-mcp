import {parseArgs} from 'node:util';
import {runVerification} from '../../adapters/typescript/verifyReferences.ts';
import {runOracleQualification} from './oracle/runOracleQualification.ts';

export type QualifyIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

const usage = `Usage: codeindex-cli qualify --extractor <id> [options]

Compares indexed facts with an adapter-specific truth source.

Options:
  --extractor <id>        Adapter to qualify: typescript or oracle
  --config <path>         Load a JSON configuration file
  --root <path>           Override the indexed workspace root
  --project-file <path>   Override the extractor project file
  --database <path>       Override the index database path
  --identifiers <path>    Oracle USER_IDENTIFIERS CSV export
  --dependencies <path>   Oracle USER_DEPENDENCIES CSV export
  --output <path>         Write the JSON report to a file
  --json                  Emit machine-readable JSON
  --help                  Print this message
`;

type QualifyOptionsType = Readonly<{
	extractor?: string | undefined;
	config?: string | undefined;
	root?: string | undefined;
	'project-file'?: string | undefined;
	database?: string | undefined;
	identifiers?: string | undefined;
	dependencies?: string | undefined;
	output?: string | undefined;
	json: boolean;
	help: boolean;
}>;

const parseQualifyArgs = (argv: readonly string[]): QualifyOptionsType => {
	const separator = argv.indexOf('--');

	return parseArgs({
		args: [...(separator === -1 ? argv : [...argv.slice(0, separator), ...argv.slice(separator + 1)])],
		options: {
			extractor: {type: 'string'},
			config: {type: 'string'},
			root: {type: 'string'},
			'project-file': {type: 'string'},
			database: {type: 'string'},
			identifiers: {type: 'string'},
			dependencies: {type: 'string'},
			output: {type: 'string'},
			json: {type: 'boolean', default: false},
			help: {type: 'boolean', default: false},
		},
		allowPositionals: false,
	}).values;
};

const environmentFor = (environment: NodeJS.ProcessEnv, values: QualifyOptionsType): NodeJS.ProcessEnv => {
	const overrides: NodeJS.ProcessEnv = {};

	for (const [name, value] of [
		['CODE_INDEX_CONFIG', values.config],
		['CODE_INDEX_ROOT', values.root],
		['CODE_INDEX_EXTRACTOR', values.extractor],
		['CODE_INDEX_PROJECT_FILE', values['project-file']],
		['CODE_INDEX_DATABASE', values.database],
	] as const) {
		if (value !== undefined) {
			overrides[name] = value;
		}
	}

	return {...environment, ...overrides};
};

/**
 * Runs semantic qualification for one adapter.
 *
 * @param argv - Arguments after `qualify`.
 * @param environment - Environment source.
 * @param io - Output sinks.
 * @returns Process exit code: 0 only when the adapter gate passes.
 */
export const runQualifyCommand = async (argv: readonly string[], environment: NodeJS.ProcessEnv, io: QualifyIoType): Promise<number> => {
	try {
		const values = parseQualifyArgs(argv);

		if (values.help) {
			io.stdout(usage.trimEnd());
			return 0;
		}

		const extractor = values.extractor ?? environment['CODE_INDEX_EXTRACTOR'] ?? 'typescript';
		const resolved = environmentFor(environment, {...values, extractor});

		if (extractor === 'typescript') {
			return runVerification(resolved, io);
		}

		if (extractor === 'oracle') {
			return await runOracleQualification(resolved, io, {
				identifiers: values.identifiers,
				dependencies: values.dependencies,
				output: values.output,
			});
		}

		throw new Error(`Unknown qualification extractor: ${extractor}`);
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
