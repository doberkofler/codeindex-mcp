import {type CheckResultType} from './assertions.ts';
import {hashOf} from './hash.ts';
import {executionCampaignDigestOf, executionCaseComparisonDigestOf} from './identity.ts';
import {type RunResultType} from './runner.ts';
import {CASE_CLASSES, type CaseClassType} from './schema.ts';
import {TREATMENT_IDS} from './treatment.ts';

/** Record discriminator for one derived aggregate report. */
export const REPORT_RECORD_TYPE = 'report' as const;

/** Report schema version. It is independent of the stored-result version. */
export const REPORT_SCHEMA_VERSION = '1.0' as const;

/** Classes reported beside the overall verdict. */
export const REPORT_CLASSES = CASE_CLASSES;

export type ReportClassType = CaseClassType;

/** Availability of one aggregate metric. */
export type MetricStateType = 'exact' | 'unavailable' | 'not-applicable';

/** One measured sample set, always carrying its sample count. */
export type SampleStatisticsType = Readonly<{
	median: number;
	p95: number;
	min: number;
	max: number;
	sampleCount: number;
}>;

/** Token aggregate; `complete` is true only when every successful run is exact. */
export type TokenStatisticsType = SampleStatisticsType &
	Readonly<{
		state: MetricStateType;
		complete: boolean;
	}>;

/** Aggregate metrics with explicit sample counts and ranges. */
export type TreatmentStatisticsType = Readonly<{
	/** Total tool-output bytes over successful runs. */
	outputBytes: SampleStatisticsType;
	/** Index, search, read, and list output bytes over successful runs. */
	retrievalBytes: SampleStatisticsType;
	toolCalls: SampleStatisticsType;
	/** Wall time over every valid execution. */
	wallTimeMs: SampleStatisticsType;
	/** Exact uncached input + output + reasoning tokens over successful runs. */
	tokens: TokenStatisticsType;
}>;

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
	/** Every aggregate above, with its sample count and range. */
	statistics: TreatmentStatisticsType;
}>;

/** One run-level value retained so every aggregate can be recomputed. */
export type RunValueType = Readonly<{
	identityDigest: string;
	attempt: number;
	caseId: string;
	caseClass: ReportClassType;
	treatment: string;
	repetition: number;
	outcome: string;
	/** True only for a complete record with usable evidence. */
	evidence: boolean;
	correctness: CheckResultType;
	workflow: CheckResultType;
	postRun: CheckResultType | null;
	outputBytes: number;
	retrievalBytes: number;
	toolCalls: number;
	indexCalls: number;
	wallTimeMs: number;
	tokens: Readonly<{value: number | null; state: MetricStateType}>;
}>;

/** Metrics compared between two paired treatments. */
export const PAIRED_METRICS = ['retrievalBytes', 'toolCalls', 'tokens', 'wallTimeMs'] as const;

export type PairedMetricNameType = (typeof PAIRED_METRICS)[number];

/** Deterministic percentile bootstrap interval for one paired effect. */
export type PairedIntervalType = Readonly<{
	low: number;
	high: number;
	confidence: 0.95;
	resamples: number;
	sampleCount: number;
	method: 'paired-by-case-percentile-bootstrap';
	seed: string;
}>;

/** One paired metric with its point estimate and bootstrap intervals. */
export type PairedMetricType = Readonly<{
	metric: PairedMetricNameType;
	unit: 'bytes' | 'calls' | 'tokens' | 'ms';
	pairCount: number;
	baselineMedian: number | null;
	treatmentMedian: number | null;
	medianDelta: number | null;
	medianRatio: number | null;
	state: MetricStateType;
	deltaInterval95: PairedIntervalType | null;
	ratioInterval95: PairedIntervalType | null;
}>;

/** One baseline/treatment comparison across paired cases. */
export type PairedComparisonType = Readonly<{
	baseline: string;
	treatment: string;
	pairCount: number;
	metrics: Readonly<Record<PairedMetricNameType, PairedMetricType>>;
}>;

/** One per-case delta for one metric. */
export type CaseMetricDeltaType = Readonly<{
	baselineMedian: number | null;
	treatmentMedian: number | null;
	delta: number | null;
	ratio: number | null;
	sampleCount: number;
}>;

/** Per-case correctness and paired efficiency deltas. */
export type CaseDeltaType = Readonly<{
	caseId: string;
	caseClass: ReportClassType;
	noIndex: number;
	accepted: number;
	candidate: number;
	candidateNonInferiorToNoIndex: boolean;
	candidateNonInferiorToAccepted: boolean;
	candidateVersusNoIndex: Readonly<Record<PairedMetricNameType, CaseMetricDeltaType>>;
}>;

/** One named gate outcome. */
export type ThresholdType = Readonly<{name: string; passed: boolean; detail: string}>;

/** One campaign-level comparison, also used verbatim for a class stratum. */
export type AnalysisType = Readonly<{
	noIndex: TreatmentSummaryType;
	accepted: TreatmentSummaryType;
	candidate: TreatmentSummaryType;
	caseDeltas: readonly CaseDeltaType[];
	paired: Readonly<{
		candidateVsNoIndex: PairedComparisonType;
		candidateVsAccepted: PairedComparisonType;
		acceptedVsNoIndex: PairedComparisonType;
	}>;
	thresholds: readonly ThresholdType[];
	passed: boolean;
}>;

/** One class stratum reported beside the overall verdict. */
export type ClassReportType = AnalysisType &
	Readonly<{
		class: ReportClassType;
		caseIds: readonly string[];
	}>;

/** Declared campaign facts that a report must state. */
export type ReportMetadataType = Readonly<{
	campaignId: string;
	schemaVersion: string;
	suite: Readonly<{id: string; version: number; hash: string; status: string}>;
	components: Readonly<Record<string, string | number>>;
	claimClass: string;
}>;

/** Complete derived report. */
export type ReportType = AnalysisType &
	Readonly<{
		recordType: typeof REPORT_RECORD_TYPE;
		schemaVersion: typeof REPORT_SCHEMA_VERSION;
		campaign: ReportMetadataType;
		sources: Readonly<{
			/** Every source result identity digest, sorted. */
			identityDigests: readonly string[];
			/** Result schema versions read, sorted. */
			schemaVersions: readonly string[];
			resultCount: number;
			/** Digest binding the campaign and every per-case comparison. */
			comparisonDigest: string;
		}>;
		runs: readonly RunValueType[];
		classes: readonly ClassReportType[];
	}>;

/** Bootstrap resamples; fixed so a report is recomputable. */
const BOOTSTRAP_RESAMPLES = 2_000;
const BOOTSTRAP_CONFIDENCE = 0.95;
const LOWER_QUANTILE = 0.025;
const UPPER_QUANTILE = 0.975;

const isEvidenceRun = (run: RunResultType): boolean => run.valid && run.defects.length === 0 && run.outcome !== 'aborted';

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

const sampleStatisticsOf = (values: readonly number[]): SampleStatisticsType => ({
	median: median(values),
	p95: percentile(values, 0.95),
	min: values.length === 0 ? 0 : Math.min(...values),
	max: values.length === 0 ? 0 : Math.max(...values),
	sampleCount: values.length,
});

const retrievalBytesOf = (run: RunResultType): number => run.familyBytes.index + run.familyBytes.search + run.familyBytes.read + run.familyBytes.list;

/**
 * Returns the claimable uncached token total, or null when any component is
 * unavailable. Missing usage is never replaced with zero or a byte estimate.
 *
 * @param run - Stored result.
 * @returns Exact input + output + reasoning tokens, or null.
 */
const tokensOf = (run: RunResultType): number | null => {
	const telemetry = run.telemetry;

	if (telemetry === undefined) {
		return run.usage.available ? run.usage.input + run.usage.output + run.usage.reasoning : null;
	}

	const entries = [telemetry.inputTokens, telemetry.outputTokens, telemetry.reasoningTokens];

	if (!entries.every((entry) => entry.state === 'exact' && entry.value !== null)) {
		return null;
	}

	return entries.reduce((total, entry) => total + (entry.value ?? 0), 0);
};

const tokenStateOf = (run: RunResultType): MetricStateType => {
	const telemetry = run.telemetry;

	if (telemetry === undefined) {
		return run.usage.available ? 'exact' : 'unavailable';
	}

	const entries = [telemetry.inputTokens, telemetry.outputTokens, telemetry.reasoningTokens];

	if (entries.every((entry) => entry.state === 'not-applicable')) {
		return 'not-applicable';
	}

	return entries.every((entry) => entry.state === 'exact' && entry.value !== null) ? 'exact' : 'unavailable';
};

const successOf = (runs: readonly RunResultType[]): number => (runs.length === 0 ? 0 : runs.filter((run) => run.grade.success).length / runs.length);

const runsOf = (runs: readonly RunResultType[], treatment: string): readonly RunResultType[] => runs.filter((run) => run.treatment === treatment);

/**
 * Summarizes one treatment's valid runs.
 *
 * @param runs - Results for the treatment.
 * @returns Aggregate metrics with explicit sample counts.
 */
export const summarizeTreatment = (runs: readonly RunResultType[]): TreatmentSummaryType => {
	const valid = runs.filter(isEvidenceRun);
	const successful = valid.filter((run) => run.grade.success);
	const truthful = valid.filter((run) => run.grade.falseAbsence || run.grade.success);
	const tokenValues = successful.map((run) => tokensOf(run)).filter((value): value is number => value !== null);
	const tokenComplete = successful.length > 0 && successful.every((run) => tokensOf(run) !== null);
	const tokenState: MetricStateType =
		tokenValues.length > 0
			? 'exact'
			: successful.length > 0 && successful.every((run) => tokenStateOf(run) === 'not-applicable')
				? 'not-applicable'
				: 'unavailable';
	const statistics: TreatmentStatisticsType = {
		outputBytes: sampleStatisticsOf(successful.map((run) => run.outputBytes)),
		retrievalBytes: sampleStatisticsOf(successful.map((run) => retrievalBytesOf(run))),
		toolCalls: sampleStatisticsOf(successful.map((run) => run.toolCalls.length)),
		wallTimeMs: sampleStatisticsOf(valid.map((run) => run.durationMs)),
		tokens: {
			...sampleStatisticsOf(tokenValues),
			state: tokenState,
			complete: tokenComplete,
		},
	};

	return {
		runs: runs.length,
		validRuns: valid.length,
		successRate: successOf(valid),
		falseAbsenceRate: truthful.length === 0 ? 0 : valid.filter((run) => run.grade.falseAbsence).length / truthful.length,
		medianOutputBytes: statistics.outputBytes.median,
		medianToolCalls: statistics.toolCalls.median,
		medianTokens: statistics.tokens.median,
		p95WallMs: statistics.wallTimeMs.p95,
		indexUsageRate: valid.length === 0 ? 0 : valid.filter((run) => run.indexCalls > 0).length / valid.length,
		executeRuns: valid.filter((run) => run.routing.executeCalls > 0).length,
		unknownToolRuns: valid.filter((run) => run.routing.unknownTools.length > 0).length,
		invalidRuns: runs.length - valid.length,
		retriedRuns: runs.filter((run) => (run.attempts?.length ?? 1) > 1).length,
		statistics,
	};
};

const metricValueOf = (run: RunResultType, metric: PairedMetricNameType): number | null => {
	if (!isEvidenceRun(run)) {
		return null;
	}

	if (metric === 'wallTimeMs') {
		return run.durationMs;
	}

	if (!run.grade.success) {
		return null;
	}

	if (metric === 'retrievalBytes') {
		return retrievalBytesOf(run);
	}

	if (metric === 'toolCalls') {
		return run.toolCalls.length;
	}

	return tokensOf(run);
};

type PairType = Readonly<{
	caseId: string;
	baseline: readonly number[];
	treatment: readonly number[];
}>;

const pairsOf = (runs: readonly RunResultType[], baseline: string, treatment: string, metric: PairedMetricNameType): readonly PairType[] => {
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

const aggregateMediansOf = (pairs: readonly PairType[]): Readonly<{baseline: number; treatment: number}> => ({
	baseline: median(pairs.map((pair) => median(pair.baseline))),
	treatment: median(pairs.map((pair) => median(pair.treatment))),
});

const rngOf = (seed: string): (() => number) => {
	let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
};

const intervalOf = (values: readonly number[], seed: string): PairedIntervalType | null => {
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

const pairedMetricOf = (runs: readonly RunResultType[], baseline: string, treatment: string, metric: PairedMetricNameType, seed: string): PairedMetricType => {
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
			state: 'unavailable',
			deltaInterval95: null,
			ratioInterval95: null,
		};
	}

	const point = aggregateMediansOf(pairs);
	const delta = point.treatment - point.baseline;
	const ratio = point.baseline === 0 ? null : point.treatment / point.baseline;

	if (pairs.length < 2) {
		return {
			metric,
			unit,
			pairCount: pairs.length,
			baselineMedian: point.baseline,
			treatmentMedian: point.treatment,
			medianDelta: delta,
			medianRatio: ratio,
			state: 'exact',
			deltaInterval95: null,
			ratioInterval95: null,
		};
	}

	const random = rngOf(intervalSeed);
	const deltas: number[] = [];
	const ratios: number[] = [];

	for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
		const drawn = Array.from({length: pairs.length}, () => pairs[Math.floor(random() * pairs.length)]).filter((pair): pair is PairType => pair !== undefined);
		const sampled = aggregateMediansOf(drawn);

		deltas.push(sampled.treatment - sampled.baseline);

		if (sampled.baseline !== 0) {
			ratios.push(sampled.treatment / sampled.baseline);
		}
	}

	return {
		metric,
		unit,
		pairCount: pairs.length,
		baselineMedian: point.baseline,
		treatmentMedian: point.treatment,
		medianDelta: delta,
		medianRatio: ratio,
		state: 'exact',
		deltaInterval95: intervalOf(deltas, intervalSeed),
		ratioInterval95: intervalOf(ratios, intervalSeed),
	};
};

const pairedComparisonOf = (runs: readonly RunResultType[], baseline: string, treatment: string, seed: string): PairedComparisonType => {
	const metrics: Record<PairedMetricNameType, PairedMetricType> = {
		retrievalBytes: pairedMetricOf(runs, baseline, treatment, 'retrievalBytes', seed),
		toolCalls: pairedMetricOf(runs, baseline, treatment, 'toolCalls', seed),
		tokens: pairedMetricOf(runs, baseline, treatment, 'tokens', seed),
		wallTimeMs: pairedMetricOf(runs, baseline, treatment, 'wallTimeMs', seed),
	};

	return {
		baseline,
		treatment,
		pairCount: Math.max(...PAIRED_METRICS.map((metric) => metrics[metric].pairCount)),
		metrics,
	};
};

const caseMetricDeltaOf = (runs: readonly RunResultType[], caseId: string, metric: PairedMetricNameType): CaseMetricDeltaType => {
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

const caseDeltasOf = (runs: readonly RunResultType[]): readonly CaseDeltaType[] => {
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
			caseClass: caseClass as ReportClassType,
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

const ratio = (treatmentValue: number, baselineValue: number): number =>
	baselineValue === 0 ? (treatmentValue === 0 ? 1 : 0) : treatmentValue / baselineValue;

const thresholdsOf = (analysis: Pick<AnalysisType, 'noIndex' | 'accepted' | 'candidate' | 'caseDeltas'>): readonly ThresholdType[] => {
	const {noIndex, accepted, candidate, caseDeltas} = analysis;
	const outputRatio = ratio(candidate.statistics.retrievalBytes.median, noIndex.statistics.retrievalBytes.median);
	const tokenRatio = ratio(candidate.statistics.tokens.median, noIndex.statistics.tokens.median);
	const timeRatio = ratio(candidate.statistics.wallTimeMs.p95, noIndex.statistics.wallTimeMs.p95);
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

const analysisOf = (runs: readonly RunResultType[], seed: string): AnalysisType => {
	const noIndex = summarizeTreatment(runsOf(runs, 'no-index'));
	const accepted = summarizeTreatment(runsOf(runs, 'accepted'));
	const candidate = summarizeTreatment(runsOf(runs, 'candidate'));
	const caseDeltas = caseDeltasOf(runs);
	const thresholds = thresholdsOf({noIndex, accepted, candidate, caseDeltas});
	const paired = {
		candidateVsNoIndex: pairedComparisonOf(runs, 'no-index', 'candidate', seed),
		candidateVsAccepted: pairedComparisonOf(runs, 'accepted', 'candidate', seed),
		acceptedVsNoIndex: pairedComparisonOf(runs, 'no-index', 'accepted', seed),
	};

	return {
		noIndex,
		accepted,
		candidate,
		caseDeltas,
		paired,
		thresholds,
		passed: thresholds.every((threshold) => threshold.passed),
	};
};

/**
 * Rejects results that cannot share one campaign or one paired case.
 *
 * The only grouping used by a report is the declared treatment. Results with an
 * undeclared treatment, a duplicate slot, or a different campaign identity are
 * rejected instead of pooled, so a caller cannot manufacture a
 * used-versus-not-used comparison from mixed results.
 *
 * @param runs - Results proposed for one report.
 */
export const assertComparableRuns = (runs: readonly RunResultType[]): void => {
	if (runs.length === 0) {
		throw new Error('a report requires at least one result');
	}

	const campaignDigests = new Set<string>();
	const caseDigests = new Map<string, string>();
	const slots = new Set<string>();
	const campaignIds = new Set<string>();

	for (const run of runs) {
		if (!(TREATMENT_IDS as readonly string[]).includes(run.treatment)) {
			throw new Error(`result ${run.caseId}/${run.treatment} has an undeclared treatment; pooled index-usage groups are not comparable`);
		}

		if (!(REPORT_CLASSES as readonly string[]).includes(run.caseClass)) {
			throw new Error(`result ${run.caseId} has unknown case class "${run.caseClass}"`);
		}

		if (run.identity.case.id !== run.caseId || run.identity.treatment.id !== run.treatment || run.identity.repetitionIndex !== run.repetition) {
			throw new Error(`result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with its execution identity`);
		}

		const slot = `${run.caseId}/${run.treatment}/${run.repetition}`;

		if (slots.has(slot)) {
			throw new Error(`results contain duplicate slot ${slot}`);
		}

		slots.add(slot);
		campaignIds.add(run.campaignId);

		const campaignDigest = executionCampaignDigestOf(run.identity);

		if (campaignDigests.size > 0 && !campaignDigests.has(campaignDigest)) {
			throw new Error('results have incompatible campaign identities; model, subject, agent, artifact, or configuration differs');
		}

		campaignDigests.add(campaignDigest);

		const caseDigest = executionCaseComparisonDigestOf(run.identity);
		const existing = caseDigests.get(run.caseId);

		if (existing !== undefined && existing !== caseDigest) {
			throw new Error(`results for case ${run.caseId} have incompatible comparison identities`);
		}

		caseDigests.set(run.caseId, caseDigest);
	}

	if (campaignIds.size !== 1) {
		throw new Error('results come from different campaigns and cannot be merged');
	}

	if (campaignDigests.size !== 1) {
		throw new Error('results have incompatible campaign identities; model, subject, agent, artifact, or configuration differs');
	}
};

const metadataOf = (runs: readonly RunResultType[], metadata: ReportMetadataType | undefined): ReportMetadataType => {
	if (metadata !== undefined) {
		return metadata;
	}

	const [first] = runs;

	if (first === undefined) {
		throw new Error('a report requires at least one result');
	}

	return {
		campaignId: first.campaignId,
		schemaVersion: first.schemaVersion,
		suite: {id: first.identity.suite.id, version: first.identity.suite.version, hash: first.identity.suite.hash, status: 'unknown'},
		components: {harnessVersion: first.identity.harness.version},
		claimClass: 'none',
	};
};

const runValuesOf = (runs: readonly RunResultType[]): readonly RunValueType[] =>
	runs
		.slice()
		.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.treatment.localeCompare(right.treatment) || left.repetition - right.repetition)
		.map((run) => ({
			identityDigest: run.identityDigest,
			attempt: run.attempt,
			caseId: run.caseId,
			caseClass: run.caseClass as ReportClassType,
			treatment: run.treatment,
			repetition: run.repetition,
			outcome: run.outcome,
			evidence: isEvidenceRun(run),
			correctness: run.grade.result,
			workflow: run.workflow.result,
			postRun: run.postRun?.result ?? null,
			outputBytes: run.outputBytes,
			retrievalBytes: retrievalBytesOf(run),
			toolCalls: run.toolCalls.length,
			indexCalls: run.indexCalls,
			wallTimeMs: run.durationMs,
			tokens: {value: tokensOf(run), state: tokenStateOf(run)},
		}));

const caseDigestsOf = (runs: readonly RunResultType[]): readonly Readonly<{caseId: string; digest: string}>[] =>
	[...new Set(runs.map((run) => run.caseId))].sort().flatMap((caseId) => {
		const [run] = runs.filter((candidate) => candidate.caseId === caseId);

		return run === undefined ? [] : [{caseId, digest: executionCaseComparisonDigestOf(run.identity)}];
	});

/**
 * Builds the complete paired report.
 *
 * Every number follows from the supplied results, and every percentile carries
 * its sample count. Bootstrap intervals use a fixed seed derived from the
 * campaign and metric, so recomputing the report yields the same interval.
 *
 * @param runs - Complete, effectively valid results for one campaign.
 * @param metadata - Declared campaign facts; derived from the results when omitted.
 * @returns The report.
 */
export const compare = (runs: readonly RunResultType[], metadata?: ReportMetadataType): ReportType => {
	assertComparableRuns(runs);

	const [first] = runs;

	if (first === undefined) {
		throw new Error('a report requires at least one result');
	}

	const campaign = metadataOf(runs, metadata);
	const identityDigests = [...new Set(runs.map((run) => run.identityDigest))].sort();
	const schemaVersions = [...new Set(runs.map((run) => run.schemaVersion))].sort();
	const comparisonDigest = hashOf({
		campaign: executionCampaignDigestOf(first.identity),
		cases: caseDigestsOf(runs),
	});
	const seed = hashOf({campaignId: campaign.campaignId, suite: campaign.suite, comparisonDigest});
	const analysis = analysisOf(runs, seed);
	const classes = REPORT_CLASSES.map((caseClass): ClassReportType => {
		const classRuns = runs.filter((run) => run.caseClass === caseClass);
		const classAnalysis = analysisOf(classRuns, hashOf({seed, caseClass}));

		return {...classAnalysis, class: caseClass, caseIds: [...new Set(classRuns.map((run) => run.caseId))].sort()};
	}).filter((report) => report.caseIds.length > 0);

	return {
		recordType: REPORT_RECORD_TYPE,
		schemaVersion: REPORT_SCHEMA_VERSION,
		campaign,
		sources: {
			identityDigests,
			schemaVersions,
			resultCount: runs.length,
			comparisonDigest,
		},
		runs: runValuesOf(runs),
		...analysis,
		classes,
	};
};
