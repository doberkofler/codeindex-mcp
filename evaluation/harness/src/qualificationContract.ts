import {type CanonicalArtifactType} from './canonicalArtifact.ts';
import {type ContractPinType} from './economicContract.ts';
import {type EnvironmentManifestType} from './environment.ts';
import {hashOf} from './hash.ts';
import {type ExecutionModelIdentityType} from './identity.ts';
import {type TrackedMetricType} from './localContract.ts';
import {type PairedMetricNameType, type PairedMetricType, type TreatmentSummaryType} from './report.ts';
import {type RunResultType} from './runTypes.ts';
import {caseHashOf, type CaseType, type SuiteType} from './schema.ts';
import {treatmentSetHashOf} from './treatment.ts';

/** Schema version of the qualification record. */
export const QUALIFICATION_SCHEMA_VERSION = 2 as const;

/** Claim class of independent local-model qualification. */
export const QUALIFICATION_CLAIM_CLASS = 'local-model-scoped' as const;

/** The two arms a qualification campaign compares. */
export const QUALIFICATION_TREATMENT_IDS = ['no-index', 'canonical'] as const;

/** Frozen release-suite size used for qualification. */
export const QUALIFICATION_CASE_COUNT = 18;

/** Paired repetitions used for qualification. */
export const QUALIFICATION_REPETITIONS = 3;

/** Fixed executions required by one qualification campaign. */
export const QUALIFICATION_EXECUTIONS = QUALIFICATION_CASE_COUNT * QUALIFICATION_TREATMENT_IDS.length * QUALIFICATION_REPETITIONS;

/** Qualification never carries product-release authority. */
export const QUALIFICATION_RELEASE_AUTHORITY = false as const;

/** Qualification never changes the frontier architecture/release gate. */
export const QUALIFICATION_FRONTIER_GATE = 'unaffected' as const;

/**
 * Criteria frozen before the first qualification campaign.
 *
 * They decide only whether the pinned local model can use the canonical artifact
 * reliably. They are not the Q2 release thresholds and never produce a release
 * verdict.
 */
export const QUALIFICATION_CRITERIA = {
	version: 1,
	correctness: {
		/** Minimum canonical success over valid slots. */
		minimumCanonicalSuccessRate: 0.9,
		/** No case may answer correctly less often than the no-index baseline. */
		maximumCaseSuccessLossVsNoIndex: 0,
		/** Every expected slot must carry valid evidence. */
		requireCompletePlan: true,
	},
	timeout: {
		/** A timed-out slot is a qualification failure, never a missing sample. */
		maximumTimedOutExecutions: 0,
		/** An aborted slot carries no grade and is a qualification failure. */
		maximumAbortedExecutions: 0,
	},
	toolUse: {
		/** Generic code-mode execution is absent from every treatment. */
		maximumExecuteCalls: 0,
		/** Every observed call must belong to the captured treatment surface. */
		maximumUnknownToolCalls: 0,
		/** Every canonical slot must actually exercise the canonical artifact. */
		minimumIndexedCanonicalRuns: QUALIFICATION_EXECUTIONS / 2,
	},
	efficiency: {
		/** Predeclared target metric; higher values are worse. */
		targetMetric: 'retrievalBytes' as TrackedMetricType,
		/** Canonical median retrieval bytes may not exceed the no-index median. */
		maximumMedianRatioVsNoIndex: 1,
		/** Canonical median tool calls may not exceed the no-index median. */
		maximumToolCallsRatioVsNoIndex: 1,
		/** Every case needs one complete paired observation. */
		minimumPairedCaseCount: QUALIFICATION_CASE_COUNT,
	},
} as const;

/**
 * Validity-v2 measurement controls adopted by local qualification.
 *
 * The hosted contract's model, tariff, and economic pins do not apply to a local
 * model. These requirements do: complete request metering, the request-1
 * treatment surface, complete corpus coverage, external-workspace isolation, and
 * aggregation over every valid run. Local qualification predeclares its own
 * correctness, timeout, tool-use, and efficiency criteria separately.
 */
export const QUALIFICATION_VALIDITY_CRITERIA = {
	version: 1,
	metering: {
		/** Every execution carries one settled request ledger. */
		requireExactRequestMetering: true,
		maximumUnsettledRequests: 0,
		maximumFailedRequests: 0,
	},
	requestOne: {
		/** Agent request 1 must present exactly the declared treatment surface. */
		requireExactSurface: true,
	},
	corpus: {
		/** Every expected path and semantic declaration must be indexed. */
		requireCompleteCoverage: true,
		requireSemanticSymbolProbes: true,
	},
	isolation: {
		/** No execution may reach the primary checkout. */
		requireExternalAttemptsZero: true,
		/** Every workspace must be restored to the pinned subject. */
		requireRestoredWorkspace: true,
		/** Mutable state must stay outside the primary checkout. */
		requireStateRootOutsideCheckout: true,
	},
} as const;

/** One evaluated criterion, with the expected bound and observed value. */
export type QualificationCriterionType = Readonly<{
	id: string;
	kind: 'correctness' | 'timeout' | 'tool-use' | 'efficiency' | 'validity';
	passed: boolean;
	expected: string;
	observed: string;
}>;

/** Corpus evidence required for one qualification case. */
export type QualificationCasePreflightType = Readonly<{
	caseId: string;
	pathsPresent: boolean;
	symbolProbe: Readonly<{symbol: string; path: string; ok: boolean}> | null;
}>;

/** Indexed-treatment evidence required for one qualification corpus preflight. */
export type QualificationTreatmentPreflightType = Readonly<{
	treatmentId: string;
	ready: boolean;
	filesIndexed: boolean;
	rootMatches: boolean;
	projectsConfigured: boolean;
	missingPaths: readonly string[];
	unindexedPaths: readonly string[];
	failures: readonly string[];
}>;

/** Corpus preflight evidence retained by the qualification record. */
export type QualificationPreflightType = Readonly<{
	result: 'pass' | 'fail';
	cases: readonly QualificationCasePreflightType[];
	treatments: readonly QualificationTreatmentPreflightType[];
	failures: readonly string[];
}>;

/** Validity-v2 evidence and its deterministic gates. */
export type QualificationValidityType = Readonly<{
	contract: ContractPinType;
	metering: Readonly<{runs: number; exactRuns: number; requests: number; unsettledRequests: number; failedRequests: number}>;
	requestOne: Readonly<{runs: number; exactRuns: number}>;
	corpus: Readonly<{
		result: 'pass' | 'fail';
		cases: number;
		casesWithPaths: number;
		symbolProbes: number;
		symbolProbesOk: number;
		missingPaths: number;
		unindexedPaths: number;
		failures: readonly string[];
	}>;
	isolation: Readonly<{
		runs: number;
		cleanRuns: number;
		restoredRuns: number;
		stateRootOutsideCheckout: boolean;
		externalPathAttempts: number;
		pathDisclosures: number;
	}>;
	checks: readonly QualificationCriterionType[];
}>;

/** Status of exactly one slot in the fixed 108-execution plan. */
export type QualificationSlotType = Readonly<{
	caseId: string;
	treatment: string;
	repetition: number;
	status: 'valid' | 'invalid';
	cause: string | null;
}>;

/** Sanitized independent local-model qualification record. */
export type QualificationReportType = Readonly<{
	recordType: 'local-model-qualification';
	schemaVersion: typeof QUALIFICATION_SCHEMA_VERSION;
	claimClass: typeof QUALIFICATION_CLAIM_CLASS;
	releaseAuthority: typeof QUALIFICATION_RELEASE_AUTHORITY;
	/** Local qualification cannot satisfy or block the hosted release gate. */
	frontierReleaseGate: typeof QUALIFICATION_FRONTIER_GATE;
	status: 'qualified' | 'disqualified';
	model: ExecutionModelIdentityType;
	environment: Readonly<{id: string; hash: string}>;
	/** Harness pin that produced and graded the campaign. */
	harness: Readonly<{version: number; schemaVersion: string}>;
	suite: Readonly<{id: string; version: number; hash: string}>;
	subject: Readonly<{revision: string; contentManifestHash: string}>;
	/** Accepted validity-v2 contract this revalidation is bound to. */
	contract: ContractPinType;
	/** Digest of every field that must stay fixed across model campaigns. */
	baseline: string;
	canonical: Readonly<{
		id: string;
		version: string;
		digest: string;
		root: string;
		entryPoint: string;
		manifestHash: string;
	}>;
	criteria: typeof QUALIFICATION_CRITERIA;
	/** Measurement-validity controls and evidence; never a hosted economic claim. */
	validity: QualificationValidityType;
	checks: readonly QualificationCriterionType[];
	plan: Readonly<{
		caseCount: number;
		treatments: readonly string[];
		repetitions: number;
		expectedExecutions: number;
		executions: number;
		validExecutions: number;
		invalidExecutions: number;
		missingExecutions: number;
	}>;
	slots: readonly QualificationSlotType[];
	treatments: Readonly<{
		noIndex: TreatmentSummaryType;
		canonical: TreatmentSummaryType;
	}>;
	efficiency: Readonly<{
		targetMetric: TrackedMetricType;
		pairs: readonly Readonly<{caseId: string; noIndexBytes: number; canonicalBytes: number}>[];
		metrics: Readonly<Record<PairedMetricNameType, PairedMetricType>>;
	}>;
	report: Readonly<{
		campaignId: string;
		identityDigests: readonly string[];
	}>;
	/** Why the pinned model qualifies. Empty for a disqualified model. */
	qualification: Readonly<{status: 'qualified' | 'disqualified'; reasons: readonly string[]}>;
	/** Why the pinned model is disqualified. Empty for a qualified model. */
	disqualification: Readonly<{reasons: readonly string[]}>;
	/** Product-release boundary, kept separate from the model verdict. */
	productRelease: Readonly<{
		claimClass: typeof QUALIFICATION_CLAIM_CLASS;
		releaseAuthority: typeof QUALIFICATION_RELEASE_AUTHORITY;
		frontierGate: typeof QUALIFICATION_FRONTIER_GATE;
		note: string;
	}>;
}>;

/** Input for one qualification record. */
export type QualificationInputType = Readonly<{
	/** Model-bound suite identity recorded by the campaign manifest. */
	suite: Readonly<{id: string; version: number; hash: string}>;
	/** Frozen suite as loaded from disk, before the model rebind. */
	loadedSuite: SuiteType;
	caseList: readonly CaseType[];
	canonical: CanonicalArtifactType;
	/** Canonical artifact identity recorded by the campaign manifest. */
	stagedCanonical: Readonly<{id: string; digest: string}>;
	environment: EnvironmentManifestType;
	subject: Readonly<{revision: string; contentManifestHash: string}>;
	harnessVersion: number;
	campaignId: string;
	claimClass: string;
	/** Accepted validity-v2 contract pin the campaign must be bound to. */
	contract: ContractPinType;
	/** Corpus preflight that preceded the campaign. */
	preflight: QualificationPreflightType;
	/** Whether the external state root resolved outside the primary checkout. */
	stateRootOutsideCheckout: boolean;
	expectedSlots: readonly Readonly<{caseId: string; treatment: string; repetition: number}>[];
	results: readonly RunResultType[];
}>;

/**
 * Hashes the fields that must stay equal for two qualification campaigns to be
 * directly comparable.
 *
 * The pinned model and environment are deliberately excluded: comparing models
 * is the purpose of the baseline. Suite identity, revision, case content,
 * treatment definitions, harness version, and the canonical artifact digest are
 * included, so any change to the comparison conditions starts a new baseline.
 *
 * @param input - Frozen suite, loaded cases, canonical artifact, and harness version.
 * @returns The qualification baseline digest.
 */
export const qualificationBaselineOf = (
	input: Readonly<{
		suite: Pick<SuiteType, 'id' | 'version' | 'revision' | 'treatments'>;
		cases: readonly CaseType[];
		canonical: CanonicalArtifactType;
		harnessVersion: number;
	}>,
): string =>
	hashOf({
		harnessVersion: input.harnessVersion,
		suite: {id: input.suite.id, version: input.suite.version},
		revision: input.suite.revision,
		cases: input.cases.map((testCase) => ({id: testCase.id, hash: caseHashOf(testCase)})),
		treatments: treatmentSetHashOf(input.suite.treatments),
		canonical: {
			id: input.canonical.id,
			digest: input.canonical.digest,
			root: input.canonical.root,
			entryPoint: input.canonical.entryPoint,
		},
	});

/**
 * Rejects a pair of qualification campaigns that are not comparable.
 *
 * @param baseline - Baseline digest of the existing campaign.
 * @param other - Baseline digest of the campaign proposed for comparison.
 */
export const assertComparableQualificationBaselines = (baseline: string, other: string): void => {
	if (baseline !== other) {
		throw new Error('qualification campaigns are not comparable; suite, revision, case content, treatment definitions, harness, or canonical artifact differs');
	}
};
