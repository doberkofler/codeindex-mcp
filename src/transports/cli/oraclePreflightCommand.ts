import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {preflightOracleEvidenceBundle, type OracleEvidencePreflightReportType} from '../../core/qualification/oracle/live/oracleEvidenceBundle.ts';
import {type CommandIoType, CommandExitError, configureCommand} from './commanderSupport.ts';

const FAILURE_LIMIT = 20;

const DEFAULT_DESCRIPTOR = 'benchmark/oracle-controlled/corpus.json';

type OraclePreflightOptionsType = Readonly<{
	bundle?: string | undefined;
	evidenceRoot?: string | undefined;
	output?: string | undefined;
	json: boolean;
}>;

const failureLinesOf = (report: OracleEvidencePreflightReportType): readonly string[] => {
	const lines = [
		...report.artifacts
			.filter((artifact) => artifact.status !== 'ok')
			.map((artifact) => `  ${artifact.status.toUpperCase()} ${artifact.path}${artifact.detail === null ? '' : ` (${artifact.detail})`}`),
		...report.identities
			.filter((identity) => identity.status !== 'ok')
			.map((identity) => `  ${identity.status.toUpperCase()} ${identity.name}: expected ${identity.expected}; found ${identity.actual}`),
	];

	return lines.length <= FAILURE_LIMIT ? lines : [...lines.slice(0, FAILURE_LIMIT), `  ... and ${String(lines.length - FAILURE_LIMIT)} more`];
};

/**
 * Reports every missing or mismatched artifact of a retained Oracle evidence
 * bundle. The check opens no database session and touches no index, so it fails
 * before any DDL-capable Oracle connection can be made.
 *
 * @param environment - Environment source; only `CODEINDEX_EVIDENCE_ROOT` is read.
 * @param io - Output sinks.
 * @param options - Bundle descriptor, root override, and optional JSON report path.
 * @returns Process exit code: 0 only when the complete bundle verifies.
 */
export const runOraclePreflight = async (environment: NodeJS.ProcessEnv, io: CommandIoType, options: OraclePreflightOptionsType): Promise<number> => {
	try {
		const report = await preflightOracleEvidenceBundle(environment, {
			descriptorPath: options.bundle ?? DEFAULT_DESCRIPTOR,
			evidenceRoot: options.evidenceRoot,
		});

		if (options.output !== undefined) {
			writeFileSync(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, {encoding: 'utf8'});
		}

		if (options.json) {
			io.stdout(JSON.stringify(report, null, 2));
		} else {
			io.stdout(`Oracle evidence preflight: ${report.ok ? 'PASS' : 'FAIL'}`);
			io.stdout(`  descriptor: ${report.descriptor}`);
			io.stdout(`  root: ${report.root}`);
			io.stdout(
				`  checks: ${String(report.summary.ok)} ok, ${String(report.summary.missing)} missing, ${String(report.summary.mismatch)} mismatch, ${String(report.summary.unverified)} unverified`,
			);

			for (const line of failureLinesOf(report)) {
				io.stdout(line);
			}
		}

		return report.ok ? 0 : 1;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};

const oraclePreflightCommand = (environment: NodeJS.ProcessEnv, io: CommandIoType): Command =>
	configureCommand(
		new Command('oracle-preflight')
			.description('Verify a retained Oracle qualification evidence bundle without opening a database')
			.option('--bundle <path>', `evidence bundle descriptor (default ${DEFAULT_DESCRIPTOR})`)
			.option('--evidence-root <path>', 'override the resolved external evidence root')
			.option('--output <path>', 'write the JSON preflight report to a file')
			.option('--json', 'emit machine-readable JSON', false),
		io,
	).action(async (values: OraclePreflightOptionsType) => {
		const code = await runOraclePreflight(environment, io, values);

		if (code !== 0) {
			throw new CommandExitError(code);
		}
	});

/**
 * Registers the Oracle evidence-bundle preflight command.
 *
 * @param program - Root CLI program.
 * @param environment - Environment that may override the evidence root.
 * @param io - Output sinks.
 */
export const addOraclePreflightCommand = (program: Command, environment: NodeJS.ProcessEnv, io: CommandIoType): void => {
	program.addCommand(oraclePreflightCommand(environment, io));
};
