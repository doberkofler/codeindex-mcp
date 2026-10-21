import {type RunResultType} from './runner.ts';

/** Aggregates for one treatment. */
export type TreatmentSummaryType = Readonly<{
	runs: number;
	validRuns: number;
	successRate: number;
	falseAbsenceRate: number;
	medianOutputBytes: number;
	medianToolCalls: number;
	medianTokens: number;
	p95WallMs: number;
	/** Share of valid runs that invoked a CodeIndex tool. */
	indexUsageRate: number;
	/** Valid runs that made a generic `execute` call. */
	executeRuns: number;
	/** Valid runs that called a tool outside the captured surface. */
	unknownToolRuns: number;
	/** Executions that ended invalid after every attempt. */
	invalidRuns: number;
	/** Executions that needed at least one retry. */
	retriedRuns: number;
}>;

/** Paired candidate comparison against both other treatments. */
export type ComparisonType = Readonly<{
	noIndex: TreatmentSummaryType;
	accepted: TreatmentSummaryType;
	candidate: TreatmentSummaryType;
	caseDeltas: readonly Readonly<{
		caseId: string;
		noIndex: number;
		accepted: number;
		candidate: number;
		candidateNonInferiorToNoIndex: boolean;
		candidateNonInferiorToAccepted: boolean;
	}>[];
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

const runsOf = (runs: readonly RunResultType[], treatment: string): readonly RunResultType[] =>
	runs.filter((run) => run.treatment === treatment);

/**
 * Summarizes one treatment's valid runs.
 *
 * @param runs - Results for the treatment.
 * @returns Aggregate metrics.
 */
export const summarizeTreatment = (runs: readonly RunResultType[]): TreatmentSummaryType => {
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
		executeRuns: valid.filter((run) => run.routing.executeCalls > 0).length,
		unknownToolRuns: valid.filter((run) => run.routing.unknownTools.length > 0).length,
		invalidRuns: runs.length - valid.length,
		retriedRuns: runs.filter((run) => (run.attempts?.length ?? 1) > 1).length,
	};
};

/**
 * Compares candidate against no-index and accepted.
 *
 * The accepted Q2 thresholds apply to candidate versus no-index. The
 * candidate-versus-accepted requirement is correctness non-inferiority, because
 * that pairing isolates the artifact change.
 *
 * @param runs - All results in the campaign.
 * @returns Three summaries, case deltas, and threshold outcomes.
 */
export const compare = (runs: readonly RunResultType[]): ComparisonType => {
	const noIndexRuns = runsOf(runs, 'no-index');
	const acceptedRuns = runsOf(runs, 'accepted');
	const candidateRuns = runsOf(runs, 'candidate');
	const noIndex = summarizeTreatment(noIndexRuns);
	const accepted = summarizeTreatment(acceptedRuns);
	const candidate = summarizeTreatment(candidateRuns);
	const caseIds = [...new Set(runs.map((run) => run.caseId))].sort();
	const caseDeltas = caseIds.map((caseId) => {
		const baseline = successOf(noIndexRuns.filter((run) => run.caseId === caseId && run.valid));
		const acceptedRate = successOf(acceptedRuns.filter((run) => run.caseId === caseId && run.valid));
		const candidateRate = successOf(candidateRuns.filter((run) => run.caseId === caseId && run.valid));

		return {
			caseId,
			noIndex: baseline,
			accepted: acceptedRate,
			candidate: candidateRate,
			candidateNonInferiorToNoIndex: candidateRate >= baseline,
			candidateNonInferiorToAccepted: candidateRate >= acceptedRate,
		};
	});

	const ratio = (candidateValue: number, baselineValue: number): number =>
		baselineValue === 0 ? (candidateValue === 0 ? 1 : 0) : candidateValue / baselineValue;
	const outputRatio = ratio(candidate.medianOutputBytes, noIndex.medianOutputBytes);
	const tokenRatio = ratio(candidate.medianTokens, noIndex.medianTokens);
	const timeRatio = ratio(candidate.p95WallMs, noIndex.p95WallMs);
	const toolDelta = candidate.medianToolCalls - noIndex.medianToolCalls;

	const thresholds = [
		{
			name: 'no case loses correctness against no-index',
			passed: caseDeltas.every((delta) => delta.candidateNonInferiorToNoIndex),
			detail: `${caseDeltas.filter((delta) => !delta.candidateNonInferiorToNoIndex).length} regressed case(s)`,
		},
		{
			name: 'candidate success at least 90%',
			passed: candidate.successRate >= 0.9,
			detail: `${(candidate.successRate * 100).toFixed(1)}%`,
		},
		{
			name: 'candidate false absence at most 2% and not above no-index',
			passed: candidate.falseAbsenceRate <= 0.02 && candidate.falseAbsenceRate <= noIndex.falseAbsenceRate,
			detail: `candidate ${(candidate.falseAbsenceRate * 100).toFixed(2)}% vs no-index ${(noIndex.falseAbsenceRate * 100).toFixed(2)}%`,
		},
		{
			name: 'median output bytes at least 10% lower than no-index',
			passed: outputRatio <= 0.9,
			detail: `${(outputRatio * 100).toFixed(1)}% of no-index`,
		},
		{
			name: 'median tool calls not higher than no-index',
			passed: toolDelta <= 0,
			detail: `${toolDelta >= 0 ? '+' : ''}${toolDelta.toFixed(1)} calls`,
		},
		{
			name: 'median tokens at most 1.05x no-index',
			passed: tokenRatio <= 1.05,
			detail: `${(tokenRatio * 100).toFixed(1)}% of no-index`,
		},
		{
			name: 'p95 wall time at most 1.2x no-index',
			passed: timeRatio <= 1.2,
			detail: `${(timeRatio * 100).toFixed(1)}% of no-index`,
		},
		{
			name: 'no case loses correctness against accepted',
			passed: caseDeltas.every((delta) => delta.candidateNonInferiorToAccepted),
			detail: `${caseDeltas.filter((delta) => !delta.candidateNonInferiorToAccepted).length} regressed case(s)`,
		},
		{
			name: 'generic execute absent from every execution',
			passed: noIndex.executeRuns === 0 && accepted.executeRuns === 0 && candidate.executeRuns === 0,
			detail: `${noIndex.executeRuns + accepted.executeRuns + candidate.executeRuns} run(s) called execute`,
		},
		{
			name: 'every observed tool was captured in its treatment surface',
			passed: noIndex.unknownToolRuns === 0 && accepted.unknownToolRuns === 0 && candidate.unknownToolRuns === 0,
			detail: `${noIndex.unknownToolRuns + accepted.unknownToolRuns + candidate.unknownToolRuns} run(s) had unknown tools`,
		},
	];

	return {noIndex, accepted, candidate, caseDeltas, thresholds, passed: thresholds.every((threshold) => threshold.passed)};
};
