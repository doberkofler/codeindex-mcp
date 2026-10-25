import {type EconomicAnalysisType, type LatencyStudyType} from './economicAnalysis.ts';
import {type PilotCaseType, type PilotDesignType} from './pilotDesign.ts';
import {type CaseClassType} from './schema.ts';

/** Closed decision classes the pilot can record. */
export const PILOT_DECISIONS = ['continue', 'redesign', 'narrow-scope', 'stop'] as const;

export type PilotDecisionType = (typeof PILOT_DECISIONS)[number];

/** One sanitized provider request retained in the trajectory. */
export type PilotRequestType = Readonly<{
	ordinal: number;
	kind: string;
	startedAt: string;
	completedAt: string | null;
	toolNames: readonly string[];
	status: 'completed' | 'failed' | 'pending';
	costUsd: number | null;
	costState: 'exact' | 'unavailable' | 'not-applicable';
}>;

/** Request-1 classification for one execution. */
export type PilotRequestOneType = Readonly<{
	state: 'present' | 'missing' | 'surface-mismatch';
	kind: string | null;
	tools: readonly string[];
	codeIndexTools: readonly string[];
	ordinaryTools: readonly string[];
	reason: string | null;
}>;

/** Index contribution and authoritative-stop behavior for one execution. */
export type PilotIndexBehaviorType = Readonly<{
	indexCalls: number;
	completedIndexCalls: number;
	authoritativeCalls: number;
	firstIndexTool: string | null;
	indexOutputBytes: number;
	ordinaryRetrievalCallsAfterFirstIndex: number;
	fallbacksAfterAuthoritative: number;
	/** `authoritative-stop` when an authoritative result ended retrieval, else null. */
	authoritativeStop: 'authoritative-stop' | null;
	indexContribution: 'none' | 'non-authoritative' | 'authoritative';
}>;

/** Paired trajectory observation for one execution. */
export type PilotTrajectoryType = Readonly<{
	caseId: string;
	caseClass: string;
	treatment: string;
	repetition: number;
	attempt: number;
	valid: boolean;
	/** Structural proof that the client event stream was captured completely. */
	streamComplete: boolean;
	/** Closed reasons the stream is incomplete; empty when it is complete. */
	streamIncompleteReasons: readonly string[];
	correct: boolean;
	falseAbsence: boolean;
	outcome: string;
	durationMs: number;
	totalUsd: number | null;
	agentOnlyUsd: number | null;
	costState: 'exact' | 'unavailable' | 'not-applicable';
	agentRequests: number;
	requestKinds: Readonly<Record<string, number>>;
	requestOne: PilotRequestOneType;
	index: PilotIndexBehaviorType;
	requests: readonly PilotRequestType[];
	toolSequence: readonly string[];
}>;

/** Aggregate trajectory classification across one treatment. */
export type PilotTrajectorySummaryType = Readonly<{
	treatment: string;
	executions: number;
	valid: number;
	streamsComplete: number;
	requestOnePresent: number;
	requestOneMismatch: number;
	indexUsed: number;
	authoritativeResults: number;
	authoritativeStops: number;
	fallbacksAfterAuthoritative: number;
	ordinaryFallbackRuns: number;
	exactCostVectors: number;
	unavailableCostVectors: number;
	requestKinds: Readonly<Record<string, number>>;
}>;

/** One class-scoped cost and trajectory summary. */
export type PilotClassSummaryType = Readonly<{
	class: CaseClassType;
	caseIds: readonly string[];
	weights: Readonly<Record<string, number>>;
	executions: number;
	valid: number;
	invalid: number;
	costRatio: number | null;
	costUpper95: number | null;
	costGatePassed: boolean;
	correctnessGatePassed: boolean;
	candidateSuccessRate: number | null;
	baselineSuccessRate: number | null;
	indexUsed: number;
	authoritativeResults: number;
	authoritativeStops: number;
	fallbackRuns: number;
}>;

/** Closed evidence behind the architecture decision. */
export type PilotDecisionRecordType = Readonly<{
	decision: PilotDecisionType;
	reason: string;
	evidence: readonly string[];
}>;

/** Campaign identity and artifacts the pilot ran. */
export type PilotCampaignType = Readonly<{
	campaignId: string;
	identityDigest: string;
	harnessVersion: number;
	revision: string | null;
	contentManifestHash: string;
	artifacts: Readonly<{
		accepted: Readonly<{id: string; digest: string}> | null;
		candidate: Readonly<{id: string; digest: string}> | null;
	}>;
}>;

/** Complete sanitized development-pilot record. */
export type PilotReportType = Readonly<{
	recordType: 'development-pilot-report';
	schemaVersion: 1;
	claimClass: 'development-pilot';
	efficacyClaim: false;
	releaseAuthority: false;
	generatedAt: string;
	design: Readonly<{id: string; digest: string; frozenAt: string}>;
	contract: Readonly<{id: string; version: number; digest: string}>;
	suite: Readonly<{id: string; version: number; hash: string}>;
	campaign: PilotCampaignType | null;
	model: PilotDesignType['model'];
	exposure: PilotDesignType['exposure'];
	plan: Readonly<{
		cases: readonly PilotCaseType[];
		repetitions: number;
		randomizationSeed: string;
		plannedExecutions: number;
		storedExecutions: number;
		validExecutions: number;
		invalidExecutions: number;
	}>;
	trajectories: readonly PilotTrajectoryType[];
	trajectorySummary: readonly PilotTrajectorySummaryType[];
	classes: readonly PilotClassSummaryType[];
	economic: EconomicAnalysisType;
	latency: LatencyStudyType;
	decision: PilotDecisionRecordType;
}>;
