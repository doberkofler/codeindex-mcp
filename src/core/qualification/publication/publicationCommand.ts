import {Command} from 'commander';
import {loadConfig} from '../../config/config.ts';
import {enableDebug} from '../../logging/debug.ts';
import {configureCommand, parseCommandAsync} from '../../../transports/cli/commanderSupport.ts';
import {PROJECTION_PROBE_MAX_ADDRESSES_PER_ROOT, PROJECTION_PROBE_MAX_REACHABILITY_STEPS_PER_ROOT, REPORT_SURFACE_BINDINGS_PER_ROOT} from './ceilings.ts';
import {createPublicationReport, formatPublicationReport, writePublicationDiagnostics, writePublicationReport} from './report.ts';

type PublicationReportOptionsType = Readonly<{
	config?: string | undefined;
	root?: string | undefined;
	extractor?: string | undefined;
	projectFile?: string | undefined;
	output?: string | undefined;
	diagnostics?: string | undefined;
	maxSurfaceBindingsPerRoot: string;
	probeMaxAddressesPerRoot: string;
	probeMaxReachabilityStepsPerRoot: string;
	skipPrototypes: boolean;
	json: boolean;
	debug: boolean;
}>;

export type PublicationReportIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

const environmentFor = (environment: NodeJS.ProcessEnv, options: PublicationReportOptionsType): NodeJS.ProcessEnv => {
	const overrides: NodeJS.ProcessEnv = {};

	for (const [name, value] of [
		['CODE_INDEX_CONFIG', options.config],
		['CODE_INDEX_ROOT', options.root],
		['CODE_INDEX_EXTRACTOR', options.extractor],
		['CODE_INDEX_PROJECT_FILE', options.projectFile],
	] as const) {
		if (value !== undefined) {
			overrides[name] = value;
		}
	}

	return {...environment, ...overrides};
};

const ceilingOf = (value: string, name: string): number => {
	const parsed = Number(value);

	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}

	return parsed;
};

const publicationCommand = (environment: NodeJS.ProcessEnv, io: PublicationReportIoType): Command =>
	configureCommand(
		new Command('publication-report').description('Run report-only publication measurements without opening or publishing an index database'),
		io,
	)
		.option('--config <path>', 'load a JSON configuration file')
		.option('--root <path>', 'override the indexed workspace root')
		.option('--extractor <id>', 'override the selected extractor')
		.option('--project-file <path>', 'override the extractor project file')
		.option('--output <path>', 'write the aggregate JSON report to a file')
		.option('--diagnostics <path>', 'write bounded local diagnostic examples to a file')
		.option('--max-surface-bindings-per-root <count>', 'report-mode finalizer surface ceiling', String(REPORT_SURFACE_BINDINGS_PER_ROOT))
		.option('--probe-max-addresses-per-root <count>', 'projection probe address budget', String(PROJECTION_PROBE_MAX_ADDRESSES_PER_ROOT))
		.option(
			'--probe-max-reachability-steps-per-root <count>',
			'projection probe reachability-step budget',
			String(PROJECTION_PROBE_MAX_REACHABILITY_STEPS_PER_ROOT),
		)
		.option('--skip-prototypes', 'skip TypeScript P-1/P-2/P-3 prototypes', false)
		.option('--json', 'emit the aggregate report on stdout', false)
		.option('--debug', 'enable codeindex:* trace output', false)
		.action((options: PublicationReportOptionsType) => {
			if (options.debug) {
				enableDebug();
			}

			const config = loadConfig(environmentFor(environment, options));
			const {report, diagnostics} = createPublicationReport({
				config,
				provisionalCeiling: ceilingOf(options.maxSurfaceBindingsPerRoot, '--max-surface-bindings-per-root'),
				projectionBudget: {
					maxAddressesPerRoot: ceilingOf(options.probeMaxAddressesPerRoot, '--probe-max-addresses-per-root'),
					maxReachabilityStepsPerRoot: ceilingOf(options.probeMaxReachabilityStepsPerRoot, '--probe-max-reachability-steps-per-root'),
				},
				includePrototypes: !options.skipPrototypes,
			});

			if (options.output !== undefined) {
				writePublicationReport(options.output, report);
			}

			if (options.diagnostics !== undefined) {
				writePublicationDiagnostics(options.diagnostics, diagnostics);
			}

			if (options.json || options.output === undefined) {
				io.stdout(JSON.stringify(report, null, 2));
				return;
			}

			io.stdout(formatPublicationReport(report).join('\n'));
		});

/**
 * Registers the report-only publication qualification command.
 *
 * @param program - Root CLI program.
 * @param environment - Environment source.
 * @param io - Output sinks.
 */
export const addPublicationReportCommand = (program: Command, environment: NodeJS.ProcessEnv, io: PublicationReportIoType): void => {
	program.addCommand(publicationCommand(environment, io));
};

/**
 * Runs one report-only publication qualification command.
 *
 * @param argv - Arguments after `publication-report`.
 * @param environment - Environment source.
 * @param io - Output sinks.
 * @returns Process exit code.
 */
export const runPublicationReportCommand = async (argv: readonly string[], environment: NodeJS.ProcessEnv, io: PublicationReportIoType): Promise<number> => {
	const program = new Command('codeindex-cli');
	program.addCommand(publicationCommand(environment, io));

	const code = await parseCommandAsync(program, ['publication-report', ...argv], io, {usageExitCode: 1});

	return code;
};
