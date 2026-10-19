import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {z} from 'zod';
import {runVerification} from '../../adapters/typescript/verifyReferences.ts';
import {parseOracleParserId} from '../../adapters/oracle/parserIdentity.ts';
import {CommandExitError, configureCommand, parseCommandAsync} from '../../transports/cli/commanderSupport.ts';
import {oracleTruthPolicyOf} from './oracle/oracleTruthPolicy.ts';
import {runOracleQualification} from './oracle/runOracleQualification.ts';

const UnitsFileSchema = z.object({
	snapshot: z.object({
		units: z.array(z.object({path: z.string(), type: z.string(), name: z.string()})),
	}),
});

const unitsOf = (filePath: string): readonly Readonly<{path: string; type: string; name: string}>[] => {
	const raw: unknown = JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));

	return UnitsFileSchema.parse(raw).snapshot.units;
};

export type QualifyIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

type QualifyOptionsType = Readonly<{
	extractor?: string | undefined;
	config?: string | undefined;
	root?: string | undefined;
	projectFile?: string | undefined;
	database?: string | undefined;
	identifiers?: string | undefined;
	dependencies?: string | undefined;
	units?: string | undefined;
	truthPolicy?: string | undefined;
	parser?: string | undefined;
	output?: string | undefined;
	json: boolean;
}>;

const addQualifyOptions = (command: Command): Command =>
	command
		.option('--extractor <id>', 'adapter to qualify: typescript or oracle')
		.option('--config <path>', 'load a JSON configuration file')
		.option('--root <path>', 'override the indexed workspace root')
		.option('--project-file <path>', 'override the extractor project file')
		.option('--database <path>', 'override the index database path')
		.option('--identifiers <path>', 'Oracle USER_IDENTIFIERS CSV export')
		.option('--dependencies <path>', 'Oracle USER_DEPENDENCIES CSV export')
		.option('--units <path>', 'Oracle qualification snapshot units JSON')
		.option('--truth-policy <version>', 'Oracle truth policy: v1 or v2 (default v2)')
		.option('--parser <parser>', 'Oracle parser for qualification: structural or antlr (default structural)')
		.option('--output <path>', 'write the JSON report to a file')
		.option('--json', 'emit machine-readable JSON', false);

const environmentFor = (environment: NodeJS.ProcessEnv, values: QualifyOptionsType): NodeJS.ProcessEnv => {
	const overrides: NodeJS.ProcessEnv = {};

	for (const [name, value] of [
		['CODE_INDEX_CONFIG', values.config],
		['CODE_INDEX_ROOT', values.root],
		['CODE_INDEX_EXTRACTOR', values.extractor],
		['CODE_INDEX_PROJECT_FILE', values.projectFile],
		['CODE_INDEX_DATABASE', values.database],
	] as const) {
		if (value !== undefined) {
			overrides[name] = value;
		}
	}

	return {...environment, ...overrides};
};

const executeQualify = async (values: QualifyOptionsType, environment: NodeJS.ProcessEnv, io: QualifyIoType): Promise<number> => {
	const extractor = values.extractor ?? environment['CODE_INDEX_EXTRACTOR'] ?? 'typescript';
	const resolved = environmentFor(environment, {...values, extractor});

	if (extractor === 'typescript') {
		return runVerification(resolved, io);
	}

	if (extractor === 'oracle') {
		const code = await runOracleQualification(resolved, io, {
			identifiers: values.identifiers,
			dependencies: values.dependencies,
			units: values.units === undefined ? undefined : unitsOf(values.units),
			truthPolicy: values.truthPolicy === undefined ? undefined : oracleTruthPolicyOf(values.truthPolicy).version,
			parser: values.parser === undefined ? undefined : parseOracleParserId(values.parser),
			output: values.output,
		});

		return code;
	}

	throw new Error(`Unknown qualification extractor: ${extractor}`);
};

const qualifyCommand = (environment: NodeJS.ProcessEnv, io: QualifyIoType): Command =>
	configureCommand(addQualifyOptions(new Command('qualify').description('Compare indexed facts with an adapter-specific truth source')), io).action(
		async (values: QualifyOptionsType) => {
			const code = await executeQualify(values, environment, io);

			if (code !== 0) {
				throw new CommandExitError(code);
			}
		},
	);

const verifyReferencesCommand = (environment: NodeJS.ProcessEnv, io: QualifyIoType): Command =>
	configureCommand(
		addQualifyOptions(new Command('verify-references').description('Verify TypeScript reference accuracy; alias for qualify --extractor typescript')),
		io,
	).action(async (values: QualifyOptionsType) => {
		const code = await executeQualify({...values, extractor: values.extractor ?? 'typescript'}, environment, io);

		if (code !== 0) {
			throw new CommandExitError(code);
		}
	});

/**
 * Registers the adapter qualification command.
 *
 * @param program - Root CLI program.
 * @param environment - Environment source.
 * @param io - Output sinks.
 */
export const addQualifyCommand = (program: Command, environment: NodeJS.ProcessEnv, io: QualifyIoType): void => {
	program.addCommand(qualifyCommand(environment, io));
};

/**
 * Registers the TypeScript reference-verification alias.
 *
 * @param program - Root CLI program.
 * @param environment - Environment source.
 * @param io - Output sinks.
 */
export const addVerifyReferencesCommand = (program: Command, environment: NodeJS.ProcessEnv, io: QualifyIoType): void => {
	program.addCommand(verifyReferencesCommand(environment, io));
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
	const program = new Command('codeindex-cli');
	program.addCommand(qualifyCommand(environment, io));
	const code = await parseCommandAsync(program, ['qualify', ...argv], io, {usageExitCode: 1});

	return code;
};
