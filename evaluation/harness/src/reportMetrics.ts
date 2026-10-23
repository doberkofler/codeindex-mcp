import {rngOf} from './bootstrapRng.ts';
import {hashOf} from './hash.ts';
import {ratioOf, ratioValueOf} from './ratio.ts';
import {
	type AnalysisType,
	type CaseDeltaType,
	type CaseMetricDeltaType,
	type MetricStateType,
	type PairedComparisonType,
	type PairedIntervalType,
	type PairedMetricType,
	type SampleStatisticsType,
	type ThresholdType,
} from './report.ts';
import {type RunResultType} from './runTypes.ts';

export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_CONFIDENCE = 0.95;
export const LOWER_QUANTILE = 0.025;
export const UPPER_QUANTILE = 0.975;
export const median = (values: readonly number[]): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

/** Metrics compared per case; every one is recorded for both arms. */
export const PAIRED_METRICS = ['retrievalBytes', 'toolCalls', 'tokens', 'wallTimeMs'] as const;

/** One comparable metric name. */
export type PairedMetricNameType = (typeof PAIRED_METRICS)[number];

/**
 * Returns the relative change between two arm medians.
 *
 * Positive over zero is unbounded, not zero. Zero over positive is zero. Two
 * zeros are equal.
 *
 * @param treatmentValue - Treatment median.
 * @param baselineValue - Baseline median.
 * @returns The numeric ratio used by a lower-is-better threshold.
 */
const ratioOfThreshold = (treatmentValue: number, baselineValue: number): number => ratioValueOf(treatmentValue, baselineValue);

export const percentile = (values: readonly number[], fraction: number): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const rank = Math.ceil(fraction * sorted.length) - 1;

	return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
};

export const sampleStatisticsOf = (values: readonly number[]): SampleStatisticsType => ({
	median: median(values),
	p95: percentile(values, 0.95),
	min: values.length === 0 ? 0 : Math.min(...values),
	max: values.length === 0 ? 0 : Math.max(...values),
	sampleCount: values.length,
});

export const retrievalBytesOf = (run: RunResultType): number => run.familyBytes.index + run.familyBytes.search + run.familyBytes.read + run.familyBytes.list;

/**
 * Sums every tool-output family, including shell/execute, task, write, and
 * unrecognized output.
 *
 * @param run - Stored result.
 * @returns Total tool-output bytes.
 */
export const allToolOutputBytesOf = (run: RunResultType): number => Object.values(run.familyBytes).reduce((total, value) => total + value, 0);

/**
 * Returns the claimable uncached token total, or null when any component is
 * unavailable. Missing usage is never replaced with zero or a byte estimate.
 *
 * @param run - Stored result.
 * @returns Exact input + output + reasoning tokens, or null.
 */
export const tokensOf = (run: RunResultType): number | null => {
	const {telemetry} = run;
	const entries = [telemetry.inputTokens, telemetry.outputTokens, telemetry.reasoningTokens];

	if (!entries.every((entry) => entry.state === 'exact' && entry.value !== null)) {
		return null;
	}

	return entries.reduce((total, entry) => total + (entry.value ?? 0), 0);
};

export const tokenStateOf = (run: RunResultType): MetricStateType => {
	const {telemetry} = run;
	const entries = [telemetry.inputTokens, telemetry.outputTokens, telemetry.reasoningTokens];

	if (entries.every((entry) => entry.state === 'not-applicable')) {
		return 'not-applicable';
	}

	return entries.every((entry) => entry.state === 'exact' && entry.value !== null) ? 'exact' : 'unavailable';
};

export const isEvidenceRun = (run: RunResultType): boolean => run.valid && run.defects.length === 0 && run.outcome !== 'aborted';

export const successOf = (runs: readonly RunResultType[]): number => (runs.length === 0 ? 0 : runs.filter((run) => run.grade.success).length / runs.length);

export const metricValueOf = (run: RunResultType, metric: PairedMetricNameType): number | null => {
	if (!(run.valid && run.defects.length === 0 && run.outcome !== 'aborted')) {
		return null;
	}

	if (metric === 'wallTimeMs') {
		return run.durationMs;
	}

	if (metric === 'retrievalBytes') {
		return retrievalBytesOf(run);
	}

	if (metric === 'toolCalls') {
		return run.toolCalls.length;
	}

	return tokensOf(run);
};

export type PairType = Readonly<{
	caseId: string;
	baseline: readonly number[];
	treatment: readonly number[];
}>;

export const pairsOf = (runs: readonly RunResultType[], baseline: string, treatment: string, metric: PairedMetricNameType): readonly PairType[] => {
	const caseIds = [...new Set(runs.map((run) => run.caseId))].sort();

	return caseIds
		.map((caseId) => {
			const baselineValues = runs
				.filter((run) => run.caseId === caseId && run.treatment === baseline)
				.map((run) => metricValueOf(run, metric))
				.filter((value): value is number => value !== null);
			const treatmentValues = runs
				.filter((run) => run.caseId === caseId && run.treatment === treatment)
				.map((run) => metricValueOf(run, metric))
				.filter((value): value is number => value !== null);

			return {caseId, baseline: baselineValues, treatment: treatmentValues};
		})
		.filter((pair) => pair.baseline.length > 0 && pair.treatment.length > 0);
};

export const aggregateMediansOf = (pairs: readonly PairType[]): Readonly<{baseline: number; treatment: number}> => ({
	baseline: median(pairs.map((pair) => median(pair.baseline))),
	treatment: median(pairs.map((pair) => median(pair.treatment))),
});

export const intervalOf = (values: readonly number[], seed: string): PairedIntervalType | null => {
	if (values.length === 0) {
		return null;
	}

	return {
		low: percentile(values, LOWER_QUANTILE),
		high: percentile(values, UPPER_QUANTILE),
		confidence: BOOTSTRAP_CONFIDENCE,
		resamples: BOOTSTRAP_RESAMPLES,
		sampleCount: values.length,
		method: 'paired-by-case-percentile-bootstrap',
		seed,
	};
};

export const pairedMetricOf = (
	runs: readonly RunResultType[],
	comparison: Readonly<{baseline: string; treatment: string; metric: PairedMetricNameType; seed: string}>,
): PairedMetricType => {
	const {baseline, treatment, metric, seed} = comparison;
	const pairs = pairsOf(runs, baseline, treatment, metric);
	const unit = metric === 'retrievalBytes' ? 'bytes' : metric === 'toolCalls' ? 'calls' : metric === 'tokens' ? 'tokens' : 'ms';
	const intervalSeed = hashOf({seed, baseline, treatment, metric});

	if (pairs.length === 0) {
		return {
			metric,
			unit,
			pairCount: 0,
			baselineMedian: null,
			treatmentMedian: null,
			medianDelta: null,
			medianRatio: null,
			ratioState: 'finite',
			ratioIntervalState: 'unavailable',
			state: 'unavailable',
			deltaInterval95: null,
			ratioInterval95: null,
		};
	}

	const point = aggregateMediansOf(pairs);
	const delta = point.treatment - point.baseline;
	const pointRatio = ratioOf(point.treatment, point.baseline);

	if (pairs.length < 2) {
		return {
			metric,
			unit,
			pairCount: pairs.length,
			baselineMedian: point.baseline,
			treatmentMedian: point.treatment,
			medianDelta: delta,
			medianRatio: pointRatio.value,
			ratioState: pointRatio.state,
			ratioIntervalState: 'unavailable',
			state: 'exact',
			deltaInterval95: null,
			ratioInterval95: null,
		};
	}

	const random = rngOf(intervalSeed);
	const deltas: number[] = [];
	const ratios: number[] = [];
	let ratioUnbounded = false;

	for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
		const drawn = Array.from({length: pairs.length}, () => pairs[Math.floor(random() * pairs.length)]).filter((pair): pair is PairType => pair !== undefined);
		const sampled = aggregateMediansOf(drawn);

		deltas.push(sampled.treatment - sampled.baseline);

		const sampledRatio = ratioOf(sampled.treatment, sampled.baseline);

		if (sampledRatio.state === 'positive-over-zero') {
			ratioUnbounded = true;
		} else if (sampledRatio.value !== null) {
			ratios.push(sampledRatio.value);
		}
	}

	return {
		metric,
		unit,
		pairCount: pairs.length,
		baselineMedian: point.baseline,
		treatmentMedian: point.treatment,
		medianDelta: delta,
		medianRatio: pointRatio.value,
		ratioState: pointRatio.state,
		ratioIntervalState: ratioUnbounded ? 'unbounded' : 'bounded',
		state: 'exact',
		deltaInterval95: intervalOf(deltas, intervalSeed),
		ratioInterval95: ratioUnbounded ? null : intervalOf(ratios, intervalSeed),
	};
};

export const pairedComparisonOf = (runs: readonly RunResultType[], baseline: string, treatment: string, seed: string): PairedComparisonType => {
	const metrics: Record<PairedMetricNameType, PairedMetricType> = {
		retrievalBytes: pairedMetricOf(runs, {baseline, treatment, metric: 'retrievalBytes', seed}),
		toolCalls: pairedMetricOf(runs, {baseline, treatment, metric: 'toolCalls', seed}),
		tokens: pairedMetricOf(runs, {baseline, treatment, metric: 'tokens', seed}),
		wallTimeMs: pairedMetricOf(runs, {baseline, treatment, metric: 'wallTimeMs', seed}),
	};

	return {
		baseline,
		treatment,
		pairCount: Math.max(...PAIRED_METRICS.map((metric) => metrics[metric].pairCount)),
		metrics,
	};
};

export const caseMetricDeltaOf = (runs: readonly RunResultType[], caseId: string, metric: PairedMetricNameType): CaseMetricDeltaType => {
	const [pair] = pairsOf(
		runs.filter((run) => run.caseId === caseId),
		'no-index',
		'candidate',
		metric,
	);

	if (pair === undefined) {
		return {baselineMedian: null, treatmentMedian: null, delta: null, ratio: null, sampleCount: 0};
	}

	const baselineMedian = median(pair.baseline);
	const treatmentMedian = median(pair.treatment);

	return {
		baselineMedian,
		treatmentMedian,
		delta: treatmentMedian - baselineMedian,
		ratio: baselineMedian === 0 ? null : treatmentMedian / baselineMedian,
		sampleCount: Math.min(pair.baseline.length, pair.treatment.length),
	};
};

export const caseDeltasOf = (runs: readonly RunResultType[]): readonly CaseDeltaType[] => {
	const caseIds = [...new Set(runs.map((run) => run.caseId))].sort();

	return caseIds.map((caseId) => {
		const noIndexRuns = runs.filter((run) => run.caseId === caseId && run.treatment === 'no-index' && isEvidenceRun(run));
		const acceptedRuns = runs.filter((run) => run.caseId === caseId && run.treatment === 'accepted' && isEvidenceRun(run));
		const candidateRuns = runs.filter((run) => run.caseId === caseId && run.treatment === 'candidate' && isEvidenceRun(run));
		const baseline = successOf(noIndexRuns);
		const acceptedRate = successOf(acceptedRuns);
		const candidateRate = successOf(candidateRuns);
		const caseClass = (candidateRuns[0] ?? acceptedRuns[0] ?? noIndexRuns[0])?.caseClass ?? 'implementation';

		return {
			caseId,
			caseClass,
			noIndex: baseline,
			accepted: acceptedRate,
			candidate: candidateRate,
			candidateNonInferiorToNoIndex: candidateRate >= baseline,
			candidateNonInferiorToAccepted: candidateRate >= acceptedRate,
			candidateVersusNoIndex: {
				retrievalBytes: caseMetricDeltaOf(runs, caseId, 'retrievalBytes'),
				toolCalls: caseMetricDeltaOf(runs, caseId, 'toolCalls'),
				tokens: caseMetricDeltaOf(runs, caseId, 'tokens'),
				wallTimeMs: caseMetricDeltaOf(runs, caseId, 'wallTimeMs'),
			},
		};
	});
};
export const thresholdsOf = (analysis: Pick<AnalysisType, 'noIndex' | 'accepted' | 'candidate' | 'caseDeltas'>): readonly ThresholdType[] => {
	const {noIndex, accepted, candidate, caseDeltas} = analysis;
	const outputRatio = ratioOfThreshold(candidate.statistics.retrievalBytes.median, noIndex.statistics.retrievalBytes.median);
	const tokenRatio = ratioOfThreshold(candidate.statistics.tokens.median, noIndex.statistics.tokens.median);
	const timeRatio = ratioOfThreshold(candidate.statistics.wallTimeMs.p95, noIndex.statistics.wallTimeMs.p95);
	const toolDelta = candidate.statistics.toolCalls.median - noIndex.statistics.toolCalls.median;
	const tokenTelemetryComplete = [noIndex, accepted, candidate].every((summary) => summary.statistics.tokens.complete);

	return [
		{
			name: 'no case loses correctness against no-index',
			passed: caseDeltas.every((delta) => delta.candidateNonInferiorToNoIndex),
			detail: `${caseDeltas.filter((delta) => !delta.candidateNonInferiorToNoIndex).length} regressed case(s)`,
		},
		{
			name: 'candidate success at least 90%',
			passed: candidate.successRate >= 0.9,
			detail: `${(candidate.successRate * 100).toFixed(1)}% (n=${candidate.validRuns})`,
		},
		{
			name: 'candidate false absence at most 2% and not above no-index',
			passed: candidate.falseAbsenceRate <= 0.02 && candidate.falseAbsenceRate <= noIndex.falseAbsenceRate,
			detail: `candidate ${(candidate.falseAbsenceRate * 100).toFixed(2)}% vs no-index ${(noIndex.falseAbsenceRate * 100).toFixed(2)}%`,
		},
		{
			name: 'median retrieval output bytes at least 10% lower than no-index',
			passed: outputRatio <= 0.9,
			detail: `${(outputRatio * 100).toFixed(1)}% of no-index (n=${candidate.statistics.retrievalBytes.sampleCount})`,
		},
		{
			name: 'median tool calls not higher than no-index',
			passed: toolDelta <= 0,
			detail: `${toolDelta >= 0 ? '+' : ''}${toolDelta.toFixed(1)} calls (n=${candidate.statistics.toolCalls.sampleCount})`,
		},
		{
			name: 'median tokens at most 1.05x no-index',
			passed: tokenTelemetryComplete && tokenRatio <= 1.05,
			detail: tokenTelemetryComplete
				? `${(tokenRatio * 100).toFixed(1)}% of no-index (n=${candidate.statistics.tokens.sampleCount})`
				: 'unavailable: a successful run has no exact token usage',
		},
		{
			name: 'p95 wall time at most 1.2x no-index',
			passed: timeRatio <= 1.2,
			detail: `${(timeRatio * 100).toFixed(1)}% of no-index (n=${candidate.statistics.wallTimeMs.sampleCount})`,
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
};
