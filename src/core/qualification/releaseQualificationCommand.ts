import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {CommandExitError, configureCommand} from '../../transports/cli/commanderSupport.ts';
import {evaluateReleaseQualification, type ReleaseQualificationReportType} from './releaseQualification.ts';
import {loadReleaseQualificationEvidence, loadReleaseQualificationManifest} from './releaseQualificationEvidence.ts';

type ReleaseQualificationIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

type ReleaseQualificationValuesType = Readonly<{
	manifest: string;
	output: string;
	summary: string;
}>;

const markdownSummaryOf = (report: ReleaseQualificationReportType): string => {
	const rows = report.gates.map((gate) => `| ${gate.status} | ${gate.id} |`);

	return [
		'# Multi-adapter release qualification',
		'',
		`- Status: **${report.status.toUpperCase()}**`,
		`- Manifest: \`${report.manifestSha256}\``,
		`- Semantic report: \`${report.semanticReportIdentity}\``,
		`- Gates: ${String(report.summary.pass)} pass, ${String(report.summary.failure)} failure`,
		'',
		'| Status | Gate |',
		'| --- | --- |',
		...rows,
		'',
	].join('\n');
};

const writeText = (filePath: string, text: string): void => {
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, text, {encoding: 'utf8'});
};

/**
 * Validates all frozen evidence and writes one JSON report plus one Markdown summary.
 *
 * @param input - Command values, path base, and output sinks.
 * @returns Process exit code: zero only when every required gate passes.
 */
const runReleaseQualification = (
	input: Readonly<{
		values: ReleaseQualificationValuesType;
		cwd: string;
		io: ReleaseQualificationIoType;
	}>,
): number => {
	const manifestPath = path.resolve(input.cwd, input.values.manifest);
	const manifest = loadReleaseQualificationManifest(manifestPath);
	const evidence = loadReleaseQualificationEvidence(manifest, manifestPath);
	const report = evaluateReleaseQualification(manifest, evidence);
	const outputPath = path.resolve(input.cwd, input.values.output);
	const summaryPath = path.resolve(input.cwd, input.values.summary);

	writeText(outputPath, `${JSON.stringify(report, null, '\t')}\n`);
	writeText(summaryPath, markdownSummaryOf(report));
	input.io.stdout(`Release qualification: ${report.status}`);
	input.io.stdout(`Report written to ${outputPath}`);
	input.io.stdout(`Summary written to ${summaryPath}`);

	if (report.status === 'failure') {
		input.io.stderr(`Release qualification failed with ${String(report.summary.failure)} failure(s)`);
		return 1;
	}

	return 0;
};

const commandOf = (io: ReleaseQualificationIoType, cwd: string): Command =>
	configureCommand(
		new Command('release')
			.description('Evaluate one frozen deterministic multi-adapter release manifest')
			.requiredOption('--manifest <path>', 'release qualification manifest')
			.requiredOption('--output <path>', 'aggregate JSON report')
			.requiredOption('--summary <path>', 'concise Markdown summary'),
		io,
	).action((values: ReleaseQualificationValuesType) => {
		const code = runReleaseQualification({values, cwd, io});

		if (code !== 0) {
			throw new CommandExitError(code);
		}
	});

/**
 * Registers the maintainer-only aggregate release qualification command.
 *
 * @param program - Root qualification program.
 * @param io - Output sinks.
 * @param cwd - Base directory for command paths.
 */
export const addReleaseQualificationCommand = (program: Command, io: ReleaseQualificationIoType, cwd: string = process.cwd()): void => {
	program.addCommand(commandOf(io, cwd));
};
