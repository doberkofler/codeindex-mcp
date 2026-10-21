import {type ArmNameType} from './schema.ts';
import {type RunResultType} from './runner.ts';

/** Aggregates for one arm. */
export type ArmSummaryType = Readonly<{
	runs: number;
	validRuns: number;
	successRate: number;
	falseAbsenceRate: number;
	medianOutputBytes: number;
	medianToolCalls: number;
	medianTokens: number;
	p95WallMs: number;
	/** Share of valid runs that invoked a codeindex tool. */
	indexUsageRate: number;
	/** Executions that ended invalid after every attempt. */
	invalidRuns: number;
	/** Executions that needed at least one retry. */
	retriedRuns: number;
}>;

/** Paired comparison between the two arms. */
export type ComparisonType = Readonly<{
	baseline: ArmSummaryType;
	indexed: ArmSummaryType;
	caseDeltas: readonly Readonly<{caseId: string; baseline: number; indexed: number; nonInferior: boolean}>[];
	thresholds: readonly Readonly<{name: string; passed: boolean; detail: string}>[];
	passed: boolean;
}>;

const median = (values: readonly number[]): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

const percentile = (values: readonly number[], fraction: number): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const rank = Math.ceil(fraction * sorted.length) - 1;

	return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
};

const tokensOf = (run: RunResultType): number => run.usage.input + run.usage.output + run.usage.reasoning;

const successOf = (runs: readonly RunResultType[]): number => (runs.length === 0 ? 0 : runs.filter((run) => run.grade.success).length / runs.length);

/**
 * Summarizes one arm's valid runs.
 *
 * @param runs - Results for the arm.
 * @returns Aggregate metrics.
 */
export const summarizeArm = (runs: readonly RunResultType[]): ArmSummaryType => {
	const valid = runs.filter((run) => run.valid);
	const successful = valid.filter((run) => run.grade.success);
	const truthful = valid.filter((run) => run.grade.falseAbsence || run.grade.success);

	return {
		runs: runs.length,
		validRuns: valid.length,
		successRate: successOf(valid),
		falseAbsenceRate: truthful.length === 0 ? 0 : valid.filter((run) => run.grade.falseAbsence).length / truthful.length,
		medianOutputBytes: median(successful.map((run) => run.outputBytes)),
		medianToolCalls: median(successful.map((run) => run.toolCalls.length)),
		medianTokens: median(successful.map((run) => tokensOf(run))),
		p95WallMs: percentile(valid.map((run) => run.durationMs), 0.95),
		indexUsageRate: valid.length === 0 ? 0 : valid.filter((run) => run.indexCalls > 0).length / valid.length,
		invalidRuns: runs.length - valid.length,
		retriedRuns: runs.filter((run) => (run.attempts?.length ?? 1) > 1).length,
	};
};

/**
 * Compares both arms against the recorded Q2 acceptance thresholds.
 *
 * @param runs - All results in the run.
 * @returns Paired comparison and threshold outcomes.
 */
export const compare = (runs: readonly RunResultType[]): ComparisonType => {
	const baseline = summarizeArm(runs.filter((run) => run.arm === 'baseline'));
	const indexed = summarizeArm(runs.filter((run) => run.arm === 'indexed'));
	const caseIds = [...new Set(runs.map((run) => run.caseId))].sort();
	const caseDeltas = caseIds.map((caseId) => {
		const base = successOf(runs.filter((run) => run.caseId === caseId && run.arm === 'baseline' && run.valid));
		const index = successOf(runs.filter((run) => run.caseId === caseId && run.arm === 'indexed' && run.valid));

		return {caseId, baseline: base, indexed: index, nonInferior: index >= base};
	});

	const ratio = (indexedValue: number, baselineValue: number): number => (baselineValue === 0 ? (indexedValue === 0 ? 1 : 0) : indexedValue / baselineValue);
	const outputRatio = ratio(indexed.medianOutputBytes, baseline.medianOutputBytes);
	const tokenRatio = ratio(indexed.medianTokens, baseline.medianTokens);
	const timeRatio = ratio(indexed.p95WallMs, baseline.p95WallMs);
	const toolDelta = indexed.medianToolCalls - baseline.medianToolCalls;

	const thresholds = [
		{
			name: 'no case loses correctness',
			passed: caseDeltas.every((delta) => delta.nonInferior),
			detail: `${caseDeltas.filter((delta) => !delta.nonInferior).length} regressed case(s)`,
		},
		{
			name: 'indexed success at least 90%',
			passed: indexed.successRate >= 0.9,
			detail: `${(indexed.successRate * 100).toFixed(1)}%`,
		},
		{
			name: 'indexed false absence at most 2% and not above baseline',
			passed: indexed.falseAbsenceRate <= 0.02 && indexed.falseAbsenceRate <= baseline.falseAbsenceRate,
			detail: `indexed ${(indexed.falseAbsenceRate * 100).toFixed(2)}% vs baseline ${(baseline.falseAbsenceRate * 100).toFixed(2)}%`,
		},
		{
			name: 'median output bytes at least 10% lower',
			passed: outputRatio <= 0.9,
			detail: `${(outputRatio * 100).toFixed(1)}% of baseline`,
		},
		{
			name: 'median tool calls not higher',
			passed: toolDelta <= 0,
			detail: `${toolDelta >= 0 ? '+' : ''}${toolDelta.toFixed(1)} calls`,
		},
		{
			name: 'median tokens at most 1.05x baseline',
			passed: tokenRatio <= 1.05,
			detail: `${(tokenRatio * 100).toFixed(1)}% of baseline`,
		},
		{
			name: 'p95 wall time at most 1.2x baseline',
			passed: timeRatio <= 1.2,
			detail: `${(timeRatio * 100).toFixed(1)}% of baseline`,
		},
	];

	return {baseline, indexed, caseDeltas, thresholds, passed: thresholds.every((threshold) => threshold.passed)};
};
