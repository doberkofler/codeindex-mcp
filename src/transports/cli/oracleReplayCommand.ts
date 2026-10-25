import path from 'node:path';
import {Command} from 'commander';
import {z} from 'zod';
import {replayOracleEvidenceBundle} from '../../core/qualification/oracle/live/oracleReplay.ts';
import {type CommandIoType, CommandExitError, configureCommand} from './commanderSupport.ts';

const FAILURE_LIMIT = 20;
const DEFAULT_DESCRIPTOR = 'benchmark/oracle-production-20261025/corpus.json';

type OracleReplayOptionsType = Readonly<{
	bundle?: string | undefined;
	evidenceRoot?: string | undefined;
}>;

const MetricSchema = z.object({recall: z.number(), precision: z.number()});

const ReplayedReportSchema = z.object({
	corpus: z.object({files: z.number().int(), objects: z.number().int()}),
	gates: z.object({ok: z.boolean()}),
	declarations: MetricSchema,
	references: MetricSchema,
	dependencies: MetricSchema,
});

type ReplayedReportType = z.infer<typeof ReplayedReportSchema>;

const percent = (value: number): string => `${(value * 100).toFixed(4)}%`;

const summaryLinesOf = (report: ReplayedReportType): readonly string[] => [
	`  corpus: ${String(report.corpus.files)} files, ${String(report.corpus.objects)} objects`,
	`  declarations: ${percent(report.declarations.recall)} recall, ${percent(report.declarations.precision)} precision`,
	`  references: ${percent(report.references.recall)} recall, ${percent(report.references.precision)} precision`,
	`  dependencies: ${percent(report.dependencies.recall)} recall, ${percent(report.dependencies.precision)} precision`,
	`  gates: ${report.gates.ok ? 'PASS' : 'FAIL'}`,
];

/**
 * Replays a retained Oracle evidence bundle without a database and checks that
 * it reproduces the committed report.
 *
 * @param environment - Environment source; only `CODEINDEX_EVIDENCE_ROOT` is read.
 * @param io - Output sinks.
 * @param options - Bundle descriptor and optional evidence-root override.
 * @returns Process exit code: 0 when replay matches the retained report.
 */
export const runOracleReplay = async (environment: NodeJS.ProcessEnv, io: CommandIoType, options: OracleReplayOptionsType): Promise<number> => {
	try {
		const result = await replayOracleEvidenceBundle(environment, {
			descriptorPath: options.bundle ?? DEFAULT_DESCRIPTOR,
			evidenceRoot: options.evidenceRoot,
		});
		const report = ReplayedReportSchema.parse(result.report);

		io.stdout(`Oracle evidence replay: ${result.matches ? 'PASS' : 'FAIL'}`);
		io.stdout(`  descriptor: ${path.resolve(options.bundle ?? DEFAULT_DESCRIPTOR)}`);
		io.stdout(`  retained report: ${result.expectedPath ?? '(none)'}`);

		for (const line of summaryLinesOf(report)) {
			io.stdout(line);
		}

		if (!result.matches) {
			const shown = result.differences.slice(0, FAILURE_LIMIT);

			for (const difference of shown) {
				io.stdout(`  DIFF ${difference}`);
			}

			if (result.differences.length > shown.length) {
				io.stdout(`  ... and ${String(result.differences.length - shown.length)} more`);
			}
		}

		return result.matches ? 0 : 1;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};

const oracleReplayCommand = (environment: NodeJS.ProcessEnv, io: CommandIoType): Command =>
	configureCommand(
		new Command('oracle-replay')
			.description('Replay a retained Oracle evidence bundle without a database and verify the committed report')
			.option('--bundle <path>', `evidence bundle descriptor (default ${DEFAULT_DESCRIPTOR})`)
			.option('--evidence-root <path>', 'override the resolved external evidence root'),
		io,
	).action(async (values: OracleReplayOptionsType) => {
		const code = await runOracleReplay(environment, io, values);

		if (code !== 0) {
			throw new CommandExitError(code);
		}
	});

/**
 * Registers the Oracle evidence-bundle replay command.
 *
 * @param program - Root CLI program.
 * @param environment - Environment that may override the evidence root.
 * @param io - Output sinks.
 */
export const addOracleReplayCommand = (program: Command, environment: NodeJS.ProcessEnv, io: CommandIoType): void => {
	program.addCommand(oracleReplayCommand(environment, io));
};
