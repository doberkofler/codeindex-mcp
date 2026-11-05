import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {type BenchmarkEvaluationSummaryType, type BenchmarkEvaluationType, type BenchmarkGateType} from './evaluationTypes.ts';
import {absoluteGate, gate} from './gates.ts';
import {
	MultiAdapterBaselineSchema,
	MultiAdapterReportSchema,
	type AdapterCountersType,
	type MultiAdapterBaselineType,
	type MultiAdapterReportType,
} from './multiAdapterTypes.ts';

const sumCounters = (counters: AdapterCountersType): number => counters.probes + counters.scans + counters.extractions + counters.factWrites;

const summaryOf = (gates: readonly BenchmarkGateType[]): BenchmarkEvaluationSummaryType => ({
	pass: gates.filter((entry) => entry.status === 'pass').length,
	warning: gates.filter((entry) => entry.status === 'warning').length,
	failure: gates.filter((entry) => entry.status === 'failure').length,
	skipped: gates.filter((entry) => entry.status === 'skipped').length,
});

const evaluationOf = (gates: readonly BenchmarkGateType[], reportGeneratedAt: string, baseline: MultiAdapterBaselineType): BenchmarkEvaluationType => {
	const summary = summaryOf(gates);

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		reportGeneratedAt,
		baselineSchemaVersion: baseline.schemaVersion,
		reportSchemaVersion: baseline.reportSchemaVersion,
		status: summary.failure > 0 ? 'failure' : summary.warning > 0 ? 'warning' : 'pass',
		summary,
		gates,
	};
};

const invalidReportEvaluation = (message: string, baseline: MultiAdapterBaselineType): BenchmarkEvaluationType =>
	evaluationOf(
		[
			gate('failure', 'compatibility.report', 'compatibility', {
				message: `Report is missing a required metric: ${message}`,
			}),
		],
		'unknown',
		baseline,
	);

const isolationGates = (report: MultiAdapterReportType): readonly BenchmarkGateType[] => {
	const offending = report.isolation.rounds.flatMap((round) => {
		const other = round.sourceAdapterId === 'typescript' ? round.oracle : round.typescript;
		const measured = sumCounters(other);

		return measured === 0 ? [] : [`${String(round.iteration)}=${String(measured)}`];
	});
	const typescriptCost = sumCounters(report.isolation.typescriptEdits.typescript);
	const oracleCost = sumCounters(report.isolation.oracleEdits.oracle);

	return [
		gate(offending.length === 0 ? 'pass' : 'failure', 'isolation.cross_adapter', 'absolute', {
			message:
				offending.length === 0
					? 'Targeted edits produced no probe, scan, extraction, or fact write for the other adapter'
					: `Targeted edits touched the other adapter in rounds ${offending.join(', ')}`,
			actual: offending.length,
			expected: 0,
			unit: 'count',
		}),
		gate(typescriptCost > 0 ? 'pass' : 'failure', 'isolation.typescript_edit_cost', 'absolute', {
			message: typescriptCost > 0 ? 'TypeScript edits exercised the TypeScript adapter' : 'TypeScript edits recorded no TypeScript adapter work',
			actual: typescriptCost,
			expected: 1,
			unit: 'count',
		}),
		gate(oracleCost > 0 ? 'pass' : 'failure', 'isolation.oracle_edit_cost', 'absolute', {
			message: oracleCost > 0 ? 'Oracle edits exercised the Oracle adapter' : 'Oracle edits recorded no Oracle adapter work',
			actual: oracleCost,
			expected: 1,
			unit: 'count',
		}),
	];
};

const coverageGates = (report: MultiAdapterReportType, baseline: MultiAdapterBaselineType): readonly BenchmarkGateType[] => {
	const sampleAdapters = new Set(report.edit.samples.map((sample) => sample.adapterId));
	const editTargets = new Set(report.corpus.editTargets.map((target) => target.adapterId));
	const missingSamples = report.edit.samples.length < baseline.thresholds.minimumEditSamples;

	return [
		gate(report.corpus.id === baseline.corpus.id ? 'pass' : 'failure', 'compatibility.corpus', 'compatibility', {
			message: 'Corpus identity must match the baseline',
			actual: report.corpus.id,
			expected: baseline.corpus.id,
		}),
		gate(report.corpus.sha256 === baseline.corpus.sha256 ? 'pass' : 'failure', 'compatibility.corpus_sha256', 'compatibility', {
			message: 'Corpus content must match the baseline',
			actual: report.corpus.sha256,
			expected: baseline.corpus.sha256,
		}),
		gate(
			report.corpus.typescriptProjectContexts >= baseline.corpus.typescriptProjectContexts ? 'pass' : 'failure',
			'coverage.typescript_contexts',
			'compatibility',
			{
				message: 'TypeScript project contexts must meet the declared corpus shape',
				actual: report.corpus.typescriptProjectContexts,
				expected: baseline.corpus.typescriptProjectContexts,
				unit: 'count',
			},
		),
		gate(report.corpus.oracleProjectContexts >= baseline.corpus.oracleProjectContexts ? 'pass' : 'failure', 'coverage.oracle_contexts', 'compatibility', {
			message: 'Oracle project contexts must meet the declared corpus shape',
			actual: report.corpus.oracleProjectContexts,
			expected: baseline.corpus.oracleProjectContexts,
			unit: 'count',
		}),
		gate(!missingSamples ? 'pass' : 'failure', 'coverage.edit_samples', 'absolute', {
			message: missingSamples ? 'Too few one-file edits were measured' : 'One-file edit sample count meets the baseline',
			actual: report.edit.samples.length,
			expected: baseline.thresholds.minimumEditSamples,
			unit: 'count',
		}),
		gate(sampleAdapters.has('typescript') && sampleAdapters.has('oracle') ? 'pass' : 'failure', 'coverage.adapter_edits', 'absolute', {
			message: 'Both adapters must have measured one-file edits',
			actual: [...sampleAdapters].sort().join(','),
			expected: 'oracle,typescript',
		}),
		gate(editTargets.has('typescript') && editTargets.has('oracle') ? 'pass' : 'failure', 'coverage.edit_targets', 'compatibility', {
			message: 'Corpus must declare one edit target per adapter',
			actual: [...editTargets].sort().join(','),
			expected: 'oracle,typescript',
		}),
	];
};

const latencyGates = (report: MultiAdapterReportType, baseline: MultiAdapterBaselineType): readonly BenchmarkGateType[] => {
	const p95 = report.edit.percentiles.p95Ms;

	if (p95 === null) {
		return [
			gate('failure', 'absolute.edit.p95', 'absolute', {
				message: 'Edit-to-fresh produced no event-to-publication samples',
				expected: baseline.thresholds.editP95FailureMs,
				unit: 'ms',
			}),
		];
	}

	return [
		absoluteGate({
			code: 'absolute.edit.p95',
			message: 'Multi-adapter event-to-publication p95',
			current: p95,
			warning: baseline.thresholds.editP95WarningMs,
			failure: baseline.thresholds.editP95FailureMs,
			unit: 'ms',
		}),
	];
};

const supersessionGates = (report: MultiAdapterReportType, baseline: MultiAdapterBaselineType): readonly BenchmarkGateType[] => [
	gate(report.supersession.discarded.length === report.supersession.attempts ? 'pass' : 'failure', 'supersession.composition', 'absolute', {
		message: 'Every discarded attempt must record cause, stage, adapter, and duration',
		actual: report.supersession.discarded.length,
		expected: report.supersession.attempts,
		unit: 'count',
	}),
	absoluteGate({
		code: 'absolute.superseded.attempts',
		message: 'Superseded attempts in one run',
		current: report.supersession.attempts,
		warning: baseline.thresholds.maxSupersededAttempts,
		failure: baseline.thresholds.maxSupersededAttempts,
		unit: 'count',
	}),
	absoluteGate({
		code: 'absolute.superseded.discarded_duration',
		message: 'Time spent on discarded attempts',
		current: report.supersession.discardedDurationMs,
		warning: baseline.thresholds.maxSupersededDiscardedMs,
		failure: baseline.thresholds.maxSupersededDiscardedMs,
		unit: 'ms',
	}),
];

const resourceGates = (report: MultiAdapterReportType, baseline: MultiAdapterBaselineType): readonly BenchmarkGateType[] => [
	report.resources.processTreeRssPeakBytes > 0
		? absoluteGate({
				code: 'absolute.process_tree.rss_peak',
				message: 'Peak process-tree RSS',
				current: report.resources.processTreeRssPeakBytes,
				warning: baseline.thresholds.processTreeRssWarningBytes,
				failure: baseline.thresholds.processTreeRssFailureBytes,
				unit: 'bytes',
			})
		: gate('failure', 'absolute.process_tree.rss_peak', 'absolute', {
				message: 'Peak process-tree RSS was not measured',
				expected: baseline.thresholds.processTreeRssFailureBytes,
				unit: 'bytes',
			}),
	report.resources.processTreeRssIdleBytes > 0
		? absoluteGate({
				code: 'absolute.process_tree.rss_idle',
				message: 'Idle process-tree RSS',
				current: report.resources.processTreeRssIdleBytes,
				warning: baseline.thresholds.idleProcessTreeRssWarningBytes,
				failure: baseline.thresholds.idleProcessTreeRssFailureBytes,
				unit: 'bytes',
			})
		: gate('failure', 'absolute.process_tree.rss_idle', 'absolute', {
				message: 'Idle process-tree RSS was not measured',
				expected: baseline.thresholds.idleProcessTreeRssFailureBytes,
				unit: 'bytes',
			}),
];

const hygieneGates = (report: MultiAdapterReportType): readonly BenchmarkGateType[] => {
	const current = report.freshness.state === 'current' && report.freshness.dirtyFileCount === 0;

	return [
		gate(current ? 'pass' : 'failure', 'hygiene.freshness', 'hygiene', {
			message: current ? 'Index is current after the final edit' : 'Index is not current after the final edit',
			actual: `${report.freshness.state}/${String(report.freshness.dirtyFileCount ?? 'unknown')}`,
			expected: 'current/0',
		}),
	];
};

/**
 * Parses one checked-in multi-adapter baseline.
 *
 * @param filePath - Baseline JSON file.
 * @returns Validated absolute thresholds and corpus identity.
 * @throws {@link Error} When the file is unreadable or invalid.
 */
export const loadMultiAdapterBaseline = (filePath: string): MultiAdapterBaselineType => {
	const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	const result = MultiAdapterBaselineSchema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid multi-adapter benchmark baseline ${filePath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

/**
 * Evaluates a multi-adapter report as a fail-closed absolute gate.
 *
 * No gate is advisory. A missing or malformed required metric fails the report
 * before any measurement can be interpreted as a pass.
 *
 * @param rawReport - Report written by the scenario.
 * @param baseline - Parsed absolute thresholds.
 * @returns Evaluation with explicit pass, warning, and failure gates.
 */
export const evaluateMultiAdapterReport = (rawReport: unknown, baseline: MultiAdapterBaselineType): BenchmarkEvaluationType => {
	const parsed = MultiAdapterReportSchema.safeParse(rawReport);

	if (!parsed.success) {
		return invalidReportEvaluation(z.prettifyError(parsed.error), baseline);
	}

	const report = parsed.data;
	const gates = [
		...coverageGates(report, baseline),
		...latencyGates(report, baseline),
		...isolationGates(report),
		...supersessionGates(report, baseline),
		...resourceGates(report, baseline),
		...hygieneGates(report),
	];

	return evaluationOf(gates, report.generatedAt, baseline);
};
