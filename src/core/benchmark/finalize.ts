import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {type BenchmarkBaselineType} from './baseline.ts';
import {type BenchmarkReportType} from './benchTypes.ts';
import {evaluateBenchmark} from './evaluate.ts';
import {type BenchmarkEvaluationType} from './evaluationTypes.ts';
import {buildBenchmarkSummary} from './summary.ts';

export type BenchmarkIoType = Readonly<{
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}>;

const writeJson = (filePath: string, value: unknown): void => {
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8'});
};

const writeReport = (report: BenchmarkReportType, output: string | undefined, io: BenchmarkIoType): string => {
	const outputPath = output ?? path.join(process.cwd(), 'benchmark', 'results', `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);

	writeJson(outputPath, report);
	io.stdout(`Benchmark written to ${outputPath}`);
	return outputPath;
};

const evaluationPathOf = (reportPath: string): string =>
	reportPath.endsWith('.json') ? `${reportPath.slice(0, -'.json'.length)}.evaluation.json` : `${reportPath}.evaluation.json`;

export type BenchmarkFinalizeInputType = Readonly<{
	readonly report: BenchmarkReportType;
	readonly baseline: BenchmarkBaselineType | null;
	readonly output: string | undefined;
	readonly evaluationPath: string | undefined;
	readonly summaryPath: string | undefined;
	readonly io: BenchmarkIoType;
}>;

/**
 * Writes benchmark artifacts, evaluates optional gates, and reports status.
 *
 * The JSON report is always written. An evaluation sidecar is written when a
 * baseline is supplied. Markdown is appended only when a summary path is given;
 * GitHub step summaries are append-only sinks shared by earlier steps.
 *
 * @param input - Report, baseline, artifact paths, and output sinks.
 * @returns Process exit code: 1 only when a gate failed.
 */
export const finalizeBenchmark = (input: BenchmarkFinalizeInputType): number => {
	const reportPath = writeReport(input.report, input.output, input.io);
	let evaluation: BenchmarkEvaluationType | null = null;

	if (input.baseline !== null) {
		evaluation = evaluateBenchmark(input.report, input.baseline);
		const evaluationPath = input.evaluationPath ?? evaluationPathOf(reportPath);

		writeJson(evaluationPath, evaluation);
		input.io.stdout(`Evaluation written to ${evaluationPath}`);
	}

	if (input.summaryPath !== undefined) {
		mkdirSync(path.dirname(input.summaryPath), {recursive: true});
		appendFileSync(input.summaryPath, buildBenchmarkSummary(input.report, evaluation), {encoding: 'utf8'});
		input.io.stdout(`Benchmark summary written to ${input.summaryPath}`);
	}

	const workspace = input.report.workspace.profile === null ? input.report.workspace.kind : `${input.report.workspace.kind}/${input.report.workspace.profile}`;

	input.io.stdout(`Corpus: ${workspace}, ${String(input.report.workspace.fileCount)} files`);

	if (evaluation !== null) {
		input.io.stdout(
			`Evaluation: ${evaluation.status} (${String(evaluation.summary.pass)} pass, ${String(evaluation.summary.warning)} warning, ${String(evaluation.summary.failure)} failure, ${String(evaluation.summary.skipped)} skipped)`,
		);

		if (evaluation.status === 'failure') {
			input.io.stderr(`Benchmark gates failed with ${String(evaluation.summary.failure)} failure(s)`);
			return 1;
		}
	}

	return 0;
};
