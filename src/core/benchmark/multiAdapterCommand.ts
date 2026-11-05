import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {CommandExitError, configureCommand} from '../../transports/cli/commanderSupport.ts';
import {type BenchmarkIoType} from './finalize.ts';
import {evaluateMultiAdapterReport, loadMultiAdapterBaseline} from './multiAdapterEvaluate.ts';
import {loadMultiAdapterCorpus, prepareMultiAdapterWorkspace} from './multiAdapterCorpus.ts';
import {runMultiAdapterScenario} from './multiAdapterScenario.ts';
import {type MultiAdapterReportType} from './multiAdapterTypes.ts';
import {type BenchmarkEvaluationType} from './evaluationTypes.ts';

const writeJson = (filePath: string, value: unknown): void => {
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8'});
};

const evaluationPathOf = (reportPath: string): string =>
	reportPath.endsWith('.json') ? `${reportPath.slice(0, -'.json'.length)}.evaluation.json` : `${reportPath}.evaluation.json`;

const summaryOf = (report: MultiAdapterReportType, evaluation: BenchmarkEvaluationType): string => {
	const rows = evaluation.gates.map(
		(entry) => `| ${entry.status} | ${entry.code} | ${String(entry.actual ?? '-')} | ${String(entry.expected ?? '-')} | ${entry.message} |`,
	);
	const samples = report.edit.samples.map(
		(sample) =>
			`| ${String(sample.iteration)} | ${sample.adapterId} | ${sample.path} | ${String(sample.latencyMs)} ms | ${String(sample.eventToPublicationMs)} ms |`,
	);

	return [
		'# Multi-adapter edit-to-fresh benchmark',
		'',
		`- Status: **${evaluation.status.toUpperCase()}**`,
		`- Corpus: ${report.corpus.id} (${report.corpus.sha256.slice(0, 12)})`,
		`- Contexts: ${String(report.corpus.typescriptProjectContexts)} TypeScript, ${String(report.corpus.oracleProjectContexts)} Oracle`,
		`- Files: ${String(report.corpus.fileCount)}, symbols: ${String(report.corpus.symbolCount)}`,
		`- Machine: ${report.machine.platform}/${report.machine.arch}, ${report.machine.cpuModel}`,
		`- Edit p95: ${report.edit.percentiles.p95Ms === null ? '-' : `${String(report.edit.percentiles.p95Ms)} ms`}`,
		`- Superseded attempts: ${String(report.supersession.attempts)} (${String(report.supersession.discardedDurationMs)} ms discarded)`,
		`- Peak process-tree RSS: ${String(report.resources.processTreeRssPeakBytes)} bytes`,
		`- Idle process-tree RSS: ${String(report.resources.processTreeRssIdleBytes)} bytes`,
		'',
		'## Gates',
		'',
		'| Status | Gate | Actual | Expected | Detail |',
		'| --- | --- | ---: | ---: | --- |',
		...rows,
		'',
		'## Edit samples',
		'',
		'| Round | Adapter | Path | Wall | Event-to-publication |',
		'| ---: | --- | --- | ---: | ---: |',
		...samples,
		'',
	].join('\n');
};

type MultiAdapterCommandValuesType = Readonly<{
	corpus?: string | undefined;
	baseline?: string | undefined;
	output?: string | undefined;
	summary?: string | undefined;
	evaluation?: string | undefined;
	rounds: string;
	workspace?: string | undefined;
	keepWorkspace: boolean;
	churn: boolean;
	timeout?: string | undefined;
}>;

const addOptions = (command: Command): Command =>
	command
		.option('--corpus <path>', 'checked-in multi-adapter corpus (default: benchmark/multi-adapter-corpus)')
		.option('--baseline <path>', 'absolute gate baseline (default: benchmark/baseline-multi-adapter.json)')
		.option('--output <path>', 'report JSON path')
		.option('--evaluation <path>', 'evaluation JSON path')
		.option('--summary <path>', 'Markdown summary path')
		.option('--rounds <n>', 'one-file edit rounds, alternating adapters', '10')
		.option('--workspace <path>', 'empty workspace to populate instead of a temporary directory')
		.option('--keep-workspace', 'retain the temporary workspace and database', false)
		.option('--no-churn', 'skip the supersession churn probe')
		.option('--timeout <ms>', 'per-publication timeout', '60000');

const parseRounds = (value: string): number => {
	const rounds = Number(value);

	if (!Number.isInteger(rounds) || rounds < 2 || rounds > 1000) {
		throw new Error('--rounds must be an integer between 2 and 1000');
	}

	return rounds;
};

const parseTimeout = (value: string | undefined): number => {
	if (value === undefined) {
		return 60_000;
	}

	const timeoutMs = Number(value);

	if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
		throw new Error('--timeout must be between 1000 and 3600000 ms');
	}

	return timeoutMs;
};

/**
 * Runs the checked-in multi-adapter corpus, evaluates its absolute gates, and
 * writes report, evaluation, and summary evidence.
 *
 * @param input - Command values, output sinks, base directory, and optional worker entry.
 * @returns Process exit code: 1 when any blocking gate failed.
 */
export const runMultiAdapterBenchmark = async (
	input: Readonly<{
		values: MultiAdapterCommandValuesType;
		io: BenchmarkIoType;
		cwd: string;
		workerEntry?: string | undefined;
	}>,
): Promise<number> => {
	const rounds = parseRounds(input.values.rounds);
	const timeoutMs = parseTimeout(input.values.timeout);
	const corpusPath = path.resolve(input.cwd, input.values.corpus ?? 'benchmark/multi-adapter-corpus');
	const baselinePath = path.resolve(input.cwd, input.values.baseline ?? 'benchmark/baseline-multi-adapter.json');
	const baseline = loadMultiAdapterBaseline(baselinePath);
	const corpus = loadMultiAdapterCorpus(corpusPath);
	const workspace = prepareMultiAdapterWorkspace({
		corpus,
		workspace: input.values.workspace,
		keep: input.values.keepWorkspace,
	});
	const reportPath =
		input.values.output === undefined
			? path.join(input.cwd, 'benchmark', 'results', `multi-adapter-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`)
			: path.resolve(input.cwd, input.values.output);

	try {
		input.io.stdout(`Corpus: ${corpus.metadata.id} (${corpus.sha256.slice(0, 12)})`);
		input.io.stdout(`Workspace: ${workspace.rootDir}`);

		const report = await runMultiAdapterScenario({
			workspace,
			rounds,
			timeoutMs,
			workerEntry: input.workerEntry,
			churn: input.values.churn,
		});
		const evaluation = evaluateMultiAdapterReport(report, baseline);
		const evaluationPath = input.values.evaluation === undefined ? evaluationPathOf(reportPath) : path.resolve(input.cwd, input.values.evaluation);

		writeJson(reportPath, report);
		writeJson(evaluationPath, evaluation);
		input.io.stdout(`Report written to ${reportPath}`);
		input.io.stdout(`Evaluation written to ${evaluationPath}`);
		input.io.stdout(
			`Evaluation: ${evaluation.status} (${String(evaluation.summary.pass)} pass, ${String(evaluation.summary.warning)} warning, ${String(evaluation.summary.failure)} failure)`,
		);

		if (input.values.summary !== undefined) {
			const summaryPath = path.resolve(input.cwd, input.values.summary);
			mkdirSync(path.dirname(summaryPath), {recursive: true});
			writeFileSync(summaryPath, summaryOf(report, evaluation), {encoding: 'utf8'});
			input.io.stdout(`Summary written to ${summaryPath}`);
		}

		if (input.values.keepWorkspace) {
			input.io.stdout(`Database: ${workspace.databasePath}`);
		}

		if (evaluation.status === 'failure') {
			input.io.stderr(`Multi-adapter benchmark gates failed with ${String(evaluation.summary.failure)} failure(s)`);
			return 1;
		}

		return 0;
	} finally {
		workspace.cleanup();
	}
};

const commandOf = (io: BenchmarkIoType, options: Readonly<{cwd: string; workerEntry?: string | undefined}>): Command =>
	configureCommand(
		addOptions(
			new Command('benchmark-multi-adapter').description(
				'Measure one-file edits across five TypeScript project contexts and one Oracle context, and enforce adapter isolation, supersession, latency, and process-tree RSS gates',
			),
		),
		io,
	).action(async (values: MultiAdapterCommandValuesType) => {
		const code = await runMultiAdapterBenchmark({
			values,
			io,
			cwd: options.cwd,
			workerEntry: options.workerEntry,
		});

		if (code !== 0) {
			throw new CommandExitError(code);
		}
	});

/**
 * Registers the multi-adapter benchmark gate.
 *
 * @param program - Root CLI program.
 * @param io - Output sinks.
 * @param options - Working directory and optional build worker entry.
 */
export const addMultiAdapterBenchmarkCommand = (
	program: Command,
	io: BenchmarkIoType,
	options: Readonly<{cwd?: string; workerEntry?: string | undefined}>,
): void => {
	program.addCommand(commandOf(io, {cwd: options.cwd ?? process.cwd(), workerEntry: options.workerEntry}));
};
