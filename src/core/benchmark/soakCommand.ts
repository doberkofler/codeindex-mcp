import path from 'node:path';
import {type Command} from 'commander';
import {createLogger} from '../logging/logger.ts';
import {type BenchmarkProfileType} from './benchTypes.ts';
import {isBenchmarkProfile} from './corpus.ts';
import {runSoak, removeSoakWorkspace, type SoakRunOptionsType} from './soakScenario.ts';
import {writeSoakMarkdown, writeSoakReport} from './soakReport.ts';
import {type SoakPlanType} from './soakTypes.ts';
import {type ConfigType} from '../config/config.ts';
import {enableDebug} from '../logging/debug.ts';
import {CommandExitError} from '../../transports/cli/commanderSupport.ts';

export type SoakCommandOptionsType = Readonly<{
	profile: string;
	rounds: string;
	burstEdits: string;
	failures: string;
	restarts: string;
	debounceMs: string;
	timeoutMs: string;
	durationMs: string;
	idleSampleMs: string;
	workspace?: string | undefined;
	output: string;
	markdown?: string | undefined;
	keepWorkspace: boolean;
	debug: boolean;
}>;

type SoakCliIoType = Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>;

const integerOf = (name: string, raw: string, minimum: number, maximum: number): number => {
	const value = Number(raw);

	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
	}

	return value;
};

const profileOf = (value: string): BenchmarkProfileType => {
	if (!isBenchmarkProfile(value)) {
		throw new Error('--profile must be one of: small, medium, large, xl');
	}

	return value;
};

export const planOf = (options: SoakCommandOptionsType): SoakPlanType => ({
	profile: profileOf(options.profile),
	rounds: integerOf('--rounds', options.rounds, 1, 100),
	burstEdits: integerOf('--burst-edits', options.burstEdits, 1, 20),
	failures: integerOf('--failures', options.failures, 0, 10),
	restarts: integerOf('--restarts', options.restarts, 0, 10),
	debounceMs: integerOf('--debounce-ms', options.debounceMs, 10, 5000),
	timeoutMs: integerOf('--timeout-ms', options.timeoutMs, 1000, 600_000),
	durationMs: integerOf('--duration-ms', options.durationMs, 0, 86_400_000),
	idleSampleMs: integerOf('--idle-sample-ms', options.idleSampleMs, 0, 600_000),
});

export const outputPathsOf = (options: SoakCommandOptionsType): Readonly<{report: string; markdown: string}> => {
	const report = path.resolve(options.output);

	return {report, markdown: options.markdown === undefined ? `${report}.md` : path.resolve(options.markdown)};
};

export const runOptionsOf = (
	configOf: () => ConfigType,
	options: SoakCommandOptionsType,
	workerEntry: string | undefined,
	io: SoakCliIoType,
): SoakRunOptionsType => {
	const plan = planOf(options);

	return {
		config: configOf(),
		profile: plan.profile,
		plan,
		logger: createLogger({minimumLevel: options.debug ? 'debug' : 'error'}),
		...(options.workspace === undefined ? {} : {workspace: path.resolve(options.workspace)}),
		...(workerEntry === undefined ? {} : {workerEntry}),
		onProgress: (progress): void => {
			const position =
				progress.iteration <= progress.rounds ? `event ${String(progress.iteration)}/${String(progress.rounds)}` : `event ${String(progress.iteration)}`;

			io.stderr(`[soak] ${position}: ${String(progress.latencyMs)} ms${progress.iteration < progress.rounds ? ', continuing' : ''}`);
		},
	};
};

/**
 * Adds the deterministic operational soak command.
 *
 * The command generates a disposable real workspace, drives the real watcher
 * and builder through a fixed edit script, injects one source-read failure,
 * restarts the index, and writes a sanitized JSON and Markdown report. It never
 * starts a model.
 *
 * @param program - Commander root program.
 * @param io - Output sinks.
 * @param runtime - Injected build-worker entry point, base configuration provider,
 * and optional run/cleanup overrides used by command tests.
 * @returns The same program with the soak command.
 */
export const addSoakCommand = (
	program: Command,
	io: SoakCliIoType,
	runtime: Readonly<{
		workerEntry?: string | undefined;
		configOf: () => ConfigType;
		run?: typeof runSoak | undefined;
		removeWorkspace?: typeof removeSoakWorkspace | undefined;
	}>,
): Command =>
	program
		.command('soak')
		.description('Run the deterministic operational soak and recovery evaluation')
		.option('--profile <name>', 'generated corpus profile: small, medium, large, xl', 'small')
		.option('--rounds <n>', 'deterministic single-edit events', '8')
		.option('--burst-edits <n>', 'edits in the during-build burst', '3')
		.option('--failures <n>', 'injected source-read failures', '1')
		.option('--restarts <n>', 'clean index restarts', '1')
		.option('--debounce-ms <n>', 'watcher debounce in milliseconds', '500')
		.option('--timeout-ms <n>', 'per-event freshness timeout in milliseconds', '60000')
		.option('--duration-ms <n>', 'minimum edit-phase duration; 0 stops after --rounds', '0')
		.option('--idle-sample-ms <n>', 'idle CPU sampling window after reconciliation; 0 disables it', '10000')
		.option('--workspace <path>', 'empty directory or existing generated corpus')
		.option('--output <path>', 'JSON report path', path.join('benchmark', 'results', 'soak.json'))
		.option('--markdown <path>', 'Markdown summary path; defaults beside --output')
		.option('--keep-workspace', 'retain the generated workspace and database')
		.option('--debug', 'enable codeindex:* trace output')
		.action(async (options: SoakCommandOptionsType) => {
			if (options.debug) {
				enableDebug();
			}

			const run = await (runtime.run ?? runSoak)(runOptionsOf(runtime.configOf, options, runtime.workerEntry, io));

			try {
				const paths = outputPathsOf(options);
				writeSoakReport(run.report, paths.report);
				writeSoakMarkdown(run.report, paths.markdown);
				io.stdout(
					`soak ${run.report.passed ? 'PASS' : 'FAIL'}: ${String(run.report.events.length)} events, p95 ${String(run.report.latency.p95Ms ?? '-')} ms, ${String(run.report.failures.length)} failure(s), ${String(run.report.restarts.length)} restart(s)`,
				);
				io.stdout(`report: ${paths.report}`);
				io.stdout(`summary: ${paths.markdown}`);

				if (options.keepWorkspace) {
					io.stdout(`workspace: ${run.workspace}`);
					io.stdout(`database: ${run.databaseDirectory}`);
				}

				if (!run.report.passed) {
					throw new CommandExitError(1, `soak blocked: ${run.report.blocking.join(', ')}`);
				}
			} finally {
				if (!options.keepWorkspace) {
					(runtime.removeWorkspace ?? removeSoakWorkspace)(run);
				}
			}
		});
