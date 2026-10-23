import {type CheckResultType} from './assertions.ts';
import {type EconomicAnalysisType} from './economicAnalysis.ts';
import {type ContractPinType} from './economicContract.ts';
import {type RatioStateType} from './ratio.ts';
import {type PairedMetricNameType} from './reportMetrics.ts';
import {type CaseClassType} from './schema.ts';

export {CASE_CLASSES as REPORT_CLASSES} from './schema.ts';

/** Record discriminator for one derived aggregate report. */
export const REPORT_RECORD_TYPE = 'report' as const;

/** Report schema version. It is independent of the stored-result version. */
export const REPORT_SCHEMA_VERSION = '1.0' as const;

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
	/** Total tool-output bytes over valid runs. */
	outputBytes: SampleStatisticsType;
	/** Every tool-output family over valid runs, including shell/execute. */
	allToolOutputBytes: SampleStatisticsType;
	/** Legacy narrower metric: index, search, read, and list output bytes. */
	retrievalBytes: SampleStatisticsType;
	toolCalls: SampleStatisticsType;
	/** Wall time over every valid execution. */
	wallTimeMs: SampleStatisticsType;
	/** Exact uncached input + output + reasoning tokens over valid runs. */
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
	allToolOutputBytes: number;
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
	/** Zero-baseline state of the point ratio. */
	ratioState: RatioStateType;
	/** Whether the bootstrap ratio interval is bounded or contains a zero baseline. */
	ratioIntervalState: 'bounded' | 'unbounded' | 'unavailable';
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
	/** Frozen contract pin; null for historical pre-v2 campaigns. */
	contract?: ContractPinType | null;
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
		/** Contract-scoped economic, correctness, latency, and output evidence. */
		economic: EconomicAnalysisType | null;
	}>;
