import {type ExposureCoreQueryType} from './exposureCore.ts';
import {type ExposureDesignType} from './exposureDesign.ts';
import {type ExposurePlanType} from './exposurePlan.ts';
import {type RatioType} from './ratio.ts';
import {type SurfaceRequestLedgerType} from './requestSurface.ts';

/** Every metric compared between the two exposure arms. */
export const EXPOSURE_METRICS = ['totalTaskCostUsd', 'requestBytes', 'responseBytes', 'toolCalls', 'wallTimeMs', 'coreQueryMs'] as const;

export type ExposureMetricNameType = (typeof EXPOSURE_METRICS)[number];

/** Closed exposure decision outcomes. */
export const EXPOSURE_RECOMMENDATIONS = ['direct-mcp', 'code-mode', 'inconclusive'] as const;

export type ExposureRecommendationType = (typeof EXPOSURE_RECOMMENDATIONS)[number];

/** One paired metric comparison over the fixed cases. */
export type ExposureMetricComparisonType = Readonly<{
	metric: ExposureMetricNameType;
	unit: 'usd' | 'bytes' | 'calls' | 'ms';
	pairCount: number;
	directMean: number | null;
	codeModeMean: number | null;
	delta: number | null;
	ratio: RatioType;
	deltaInterval95: Readonly<{low: number; high: number; confidence: 0.95}> | null;
	ratioInterval95: Readonly<{low: number; high: number; confidence: 0.95}> | null;
	oneSidedUpper95: number | null;
	oneSidedUpperState: 'bounded' | 'unbounded' | 'unavailable';
	state: 'exact' | 'unavailable';
	reason: string | null;
}>;

/** Request-1 surface evidence for one exposure arm. */
export type ExposureSurfaceType = Readonly<{
	treatment: 'direct-mcp' | 'code-mode';
	declared: readonly string[];
	executions: number;
	exact: number;
	failures: readonly Readonly<{caseId: string; repetition: number; cause: string | null; differences: readonly string[]}>[];
}>;

/** Exact-metering and execution reliability facts. */
export type ExposureReliabilityType = Readonly<{
	plannedExecutions: number;
	storedExecutions: number;
	validExecutions: number;
	invalidExecutions: number;
	exactMetering: number;
	pathClean: boolean;
	timedOut: number;
	retriedSlots: number;
	failedAttempts: number;
}>;

/** Paired correctness non-inferiority of Code Mode against direct MCP. */
export type ExposureCorrectnessType = Readonly<{
	state: 'exact' | 'unavailable';
	directSuccessRate: number | null;
	codeModeSuccessRate: number | null;
	/** Direct minus Code Mode; positive means Code Mode degraded. */
	pairedDegradation: number | null;
	oneSidedUpper95: number | null;
	margin: number;
	falseAbsenceCount: number;
	gate: Readonly<{passed: boolean; detail: string}>;
	reason: string | null;
}>;

/** One execution reduced to the exposure metrics. */
export type ExposureTrajectoryType = Readonly<{
	caseId: string;
	treatment: string;
	repetition: number;
	valid: boolean;
	exactMetering: boolean;
	correct: boolean;
	falseAbsence: boolean;
	requestOne: SurfaceRequestLedgerType;
	requestCount: number;
	requestBytes: number;
	responseBytes: number | null;
	toolCalls: number;
	executeCalls: number;
	codeIndexCalls: number;
	wallTimeMs: number;
	coreQueryMs: number | null;
	totalTaskCostUsd: number | null;
	pathClean: boolean;
	timedOut: boolean;
	attemptCount: number;
	toolSequence: readonly string[];
}>;

/** Closed action attached to one exposure recommendation. */
export type ExposureDecisionActionType = 'retain-frozen-direct' | 'reopen-frozen-exposure' | 'blocked';

/** Closed recommendation record. */
export type ExposureDecisionType = Readonly<{
	recommendation: ExposureRecommendationType;
	action: ExposureDecisionActionType;
	reason: string;
	scope: string;
	changesCertification: false;
	evidence: readonly string[];
}>;

/** Complete sanitized exposure-comparison report. */
export type ExposureReportType = Readonly<{
	recordType: 'exposure-comparison-report';
	schemaVersion: 1;
	claimClass: 'hosted-model-scoped';
	generatedAt: string;
	design: Readonly<{id: string; digest: string; frozenAt: string}>;
	/** Campaign that produced the executions; null when no run exists. */
	campaign: Readonly<{id: string; slotIdentityDigest: string}> | null;
	contract: ExposureDesignType['contract'];
	suite: ExposureDesignType['suite'];
	model: ExposureDesignType['model'];
	artifact: ExposureDesignType['artifact'];
	ordinaryTools: readonly string[];
	tariff: ExposureDesignType['tariff'];
	frozenProduction: ExposureDesignType['frozenProduction'];
	plan: Readonly<{seed: string; sourceDigest: string; plannedExecutions: number; pairs: ExposurePlanType['pairs']}>;
	coreQuery: ExposureCoreQueryType;
	surfaces: Readonly<{direct: ExposureSurfaceType; codeMode: ExposureSurfaceType}>;
	reliability: ExposureReliabilityType;
	trajectories: readonly ExposureTrajectoryType[];
	metrics: Readonly<Record<ExposureMetricNameType, ExposureMetricComparisonType>>;
	correctness: ExposureCorrectnessType;
	decision: ExposureDecisionType;
	limitations: readonly string[];
}>;
