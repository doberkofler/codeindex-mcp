import {type HostedReferenceType} from './hostedReference.ts';
import {type TrackedMetricType} from './localContract.ts';
import {type PairedMetricNameType} from './reportMetrics.ts';
import {type PairedComparisonType, type PairedMetricType, type ReportType, type ThresholdType} from './report.ts';
import {type RunResultType} from './runTypes.ts';
import {type CaseClassType} from './schema.ts';

export const RELEASE_CLAIM_CLASS = 'hosted-model-scoped' as const;

/** Frozen release suite size. */
export const RELEASE_CASE_COUNT = 18;

/** Treatments compared by a hosted release campaign. */
export const RELEASE_TREATMENT_IDS = ['no-index', 'accepted', 'candidate'] as const;

/** Paired repetitions required for release authority. */
export const RELEASE_REPETITIONS = 5;

/** Fixed executions required by a hosted release campaign. */
export const RELEASE_EXECUTIONS = RELEASE_CASE_COUNT * RELEASE_TREATMENT_IDS.length * RELEASE_REPETITIONS;

/** One artifact identity recorded by a release precondition. */
export type ReleaseArtifactType = Readonly<{id: string; digest: string}>;

/** The accepted and candidate artifacts a campaign compares. */
export type ReleaseArtifactsType = Readonly<{
	accepted: ReleaseArtifactType | null;
	candidate: ReleaseArtifactType | null;
}>;

/** Pinned facts a release campaign must match. */
export type ReleaseExpectationType = Readonly<{
	suite: Readonly<{id: string; version: number; hash: string; revision: string}>;
	/** Frozen case identities, independent of the model-bound suite hash. */
	cases: readonly Readonly<{id: string; hash: string}>[];
	targetMetric: TrackedMetricType;
	artifacts: ReleaseArtifactsType;
}>;

/** The model-free stage that must pass before a release campaign may start. */
export type ReleasePreconditionType = Readonly<{
	kind: 'model-free';
	recordType: string;
	id: string;
	digest: string;
	suite: Readonly<{id: string; version: number; hash: string}>;
	artifacts: ReleaseArtifactsType;
	model: string | null;
	environment: Readonly<{id: string; hash: string}> | null;
}>;

/** Status of exactly one slot in the 270-execution release plan. */
export type ReleaseSlotType = Readonly<{
	caseId: string;
	treatment: string;
	repetition: number;
	status: 'valid' | 'invalid';
	/** Closed invalidity cause; null only for a valid slot. */
	cause: string | null;
}>;

/** One statistically supported candidate regression. */
export type ReleaseRegressionType = Readonly<{
	scope: 'overall' | 'class';
	caseClass: CaseClassType | null;
	metric: PairedMetricNameType;
	ratio: number;
	interval: Readonly<{low: number; high: number; confidence: 0.95}>;
}>;

/** Class-stratified verdict with paired bootstrap intervals. */
export type ReleaseClassVerdictType = Readonly<{
	class: CaseClassType;
	caseIds: readonly string[];
	success: Readonly<{noIndex: number; accepted: number; candidate: number}>;
	targetMetric: TrackedMetricType;
	target: PairedMetricType;
	metrics: Readonly<Record<PairedMetricNameType, PairedMetricType>>;
	thresholds: readonly ThresholdType[];
	regressions: readonly ReleaseRegressionType[];
	passed: boolean;
}>;

/** The overall release verdict with paired bootstrap intervals. */
export type ReleaseOverallVerdictType = Readonly<{
	success: Readonly<{noIndex: number; accepted: number; candidate: number}>;
	targetMetric: TrackedMetricType;
	target: PairedMetricType;
	metrics: Readonly<Record<PairedMetricNameType, PairedMetricType>>;
	thresholds: readonly ThresholdType[];
	regressions: readonly ReleaseRegressionType[];
	passed: boolean;
}>;

/** Complete hosted release campaign record. */
export type ReleaseCampaignReportType = Readonly<{
	recordType: 'release-campaign';
	schemaVersion: 1;
	claimClass: typeof RELEASE_CLAIM_CLASS;
	/** A hosted campaign carries release authority; local evidence never does. */
	releaseAuthority: true;
	hosted: Readonly<{
		id: string;
		digest: string;
		provider: string;
		modelId: string;
		reference: string;
		releasedAt: string;
	}>;
	suite: Readonly<{id: string; version: number; hash: string}>;
	revision: string;
	targetMetric: TrackedMetricType;
	preconditions: Readonly<{
		modelFree: ReleasePreconditionType;
	}>;
	plan: Readonly<{
		caseCount: number;
		treatments: readonly string[];
		repetitions: number;
		expectedExecutions: number;
		executions: number;
		validExecutions: number;
		invalidExecutions: number;
	}>;
	slots: readonly ReleaseSlotType[];
	report: Readonly<{
		campaignId: string;
		comparisonDigest: string;
		identityDigests: readonly string[];
	}>;
	paired: Readonly<{
		candidateVsNoIndex: PairedComparisonType;
		candidateVsAccepted: PairedComparisonType;
	}>;
	overall: ReleaseOverallVerdictType;
	classes: readonly ReleaseClassVerdictType[];
	passed: boolean;
	blocking: readonly string[];
}>;

/** Input for one complete release campaign record. */
export type ReleaseCampaignInputType = Readonly<{
	hosted: HostedReferenceType;
	expectation: ReleaseExpectationType;
	preconditions: ReleaseCampaignReportType['preconditions'];
	expectedSlots: readonly Readonly<{caseId: string; treatment: string; repetition: number}>[];
	results: readonly RunResultType[];
	report: ReportType;
}>;
