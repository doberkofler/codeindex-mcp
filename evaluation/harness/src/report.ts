import {type CheckResultType} from './assertions.ts';
import {hashOf} from './hash.ts';
import {executionCampaignDigestOf, executionCaseComparisonDigestOf} from './identity.ts';
import {
	caseDeltasOf,
	isEvidenceRun,
	pairedComparisonOf,
	type PairedMetricNameType,
	retrievalBytesOf,
	sampleStatisticsOf,
	successOf,
	thresholdsOf,
	tokenStateOf,
	tokensOf,
} from './reportMetrics.ts';
import {type RunResultType} from './runTypes.ts';
import {CASE_CLASSES, type CaseClassType} from './schema.ts';
import {TREATMENT_IDS} from './treatment.ts';

export {type PairedMetricNameType} from './reportMetrics.ts';

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

const runsOf = (runs: readonly RunResultType[], treatment: string): readonly RunResultType[] => runs.filter((run) => run.treatment === treatment);

/**
 * Summarizes one treatment's valid runs.
 *
 * @param runs - Results for the treatment.
 * @returns Aggregate metrics with explicit sample counts.
 */
export const summarizeTreatment = (runs: readonly RunResultType[]): TreatmentSummaryType => {
	const valid = runs.filter((run) => isEvidenceRun(run));
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
		retriedRuns: runs.filter((run) => run.attempts.length > 1).length,
		statistics,
	};
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

/** Comparable keys of one stored result. */
type RunKeysType = Readonly<{
	slot: string;
	campaignDigest: string;
	caseDigest: string;
	treatmentDigest: string;
}>;

/**
 * Validates one result and returns the keys it is compared by.
 *
 * @param run - Stored result.
 * @returns Slot, campaign, case, and per-treatment configuration digests.
 */
const runKeysOf = (run: RunResultType): RunKeysType => {
	if (!(TREATMENT_IDS as readonly string[]).includes(run.treatment)) {
		throw new Error(`result ${run.caseId}/${run.treatment} has an undeclared treatment; pooled index-usage groups are not comparable`);
	}

	if (!(REPORT_CLASSES as readonly string[]).includes(run.caseClass)) {
		throw new Error(`result ${run.caseId} has unknown case class "${run.caseClass}"`);
	}

	if (run.identity.case.id !== run.caseId || run.identity.treatment.id !== run.treatment || run.identity.repetitionIndex !== run.repetition) {
		throw new Error(`result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with its execution identity`);
	}

	return {
		slot: `${run.caseId}/${run.treatment}/${run.repetition}`,
		campaignDigest: executionCampaignDigestOf(run.identity),
		caseDigest: executionCaseComparisonDigestOf(run.identity),
		treatmentDigest: hashOf({
			agent: {toolListHash: run.identity.agent.toolListHash, permissionsHash: run.identity.agent.permissionsHash},
			codeIndex: run.identity.codeIndex,
		}),
	};
};

/**
 * Rejects results that cannot share one campaign or one paired case.
 *
 * The only grouping used by a report is the declared treatment. Results with an
 * undeclared treatment, a duplicate slot, or a different campaign identity are
 * rejected instead of pooled, so a caller cannot manufacture a
 * used-versus-not-used comparison from mixed results. Tool and CodeIndex
 * configuration may differ between treatments by design, but must stay identical
 * within one treatment.
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
	const treatmentDigests = new Map<string, string>();

	for (const run of runs) {
		const keys = runKeysOf(run);

		if (slots.has(keys.slot)) {
			throw new Error(`results contain duplicate slot ${keys.slot}`);
		}

		slots.add(keys.slot);
		campaignIds.add(run.campaignId);

		const existingTreatmentDigest = treatmentDigests.get(run.treatment);

		if (existingTreatmentDigest !== undefined && existingTreatmentDigest !== keys.treatmentDigest) {
			throw new Error(`results for treatment ${run.treatment} disagree on tool or CodeIndex configuration`);
		}

		treatmentDigests.set(run.treatment, keys.treatmentDigest);

		if (campaignDigests.size > 0 && !campaignDigests.has(keys.campaignDigest)) {
			throw new Error('results have incompatible campaign identities; model, subject, agent, artifact, or configuration differs');
		}

		campaignDigests.add(keys.campaignDigest);

		const existingCaseDigest = caseDigests.get(run.caseId);

		if (existingCaseDigest !== undefined && existingCaseDigest !== keys.caseDigest) {
			throw new Error(`results for case ${run.caseId} have incompatible comparison identities`);
		}

		caseDigests.set(run.caseId, keys.caseDigest);
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
	[...runs]
		.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.treatment.localeCompare(right.treatment) || left.repetition - right.repetition)
		.map((run) => ({
			identityDigest: run.identityDigest,
			attempt: run.attempt,
			caseId: run.caseId,
			caseClass: run.caseClass,
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
		const run = runs.find((candidate) => candidate.caseId === caseId);

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
