import {type ArtifactRefType} from './artifact.ts';
import {type RunEventsType, type TelemetryType} from './events.ts';
import {type GradeType} from './grade.ts';
import {type ExecutionIdentityType} from './identity.ts';
import {type ClientStoreModeType, type IsolationModeType} from './isolation.ts';
import {type PostRunResultType} from './postRun.ts';
import {type DefectType} from './result.ts';
import {type CaseClassType} from './schema.ts';
import {type RoutingType, type ToolSurfaceType} from './treatment.ts';
import {type WorkflowResultType} from './workflow.ts';

/** Final execution outcome, independent of correctness and workflow. */
export type OutcomeType = 'completed' | 'failed' | 'timed-out' | 'aborted';

/** Environment facts verified before an execution and recorded in its result. */
export type ExecutionIsolationType = Readonly<{
	mode: IsolationModeType;
	clientStore: ClientStoreModeType;
	/** True when the workspace was clean at the pinned subject before the run. */
	checkoutClean: boolean;
	/** True when the workspace was at the pinned revision before the run. */
	revisionMatch: boolean;
	/** True when the workspace was restored to the pinned subject after the run. */
	restored: boolean;
}>;

/** Artifact identities recorded with one result. */
export type RunArtifactsType = Readonly<{
	accepted: ArtifactRefType | null;
	candidate: ArtifactRefType | null;
	loaded: ArtifactRefType | null;
}>;

/** One execution attempt, including throttled attempts that are not runs. */
export type AttemptLogType = Readonly<{
	attempt: number;
	startedAt: string;
	durationMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	rateLimited: boolean;
	invalidReason: string | null;
	/** Bounded raw event stream for this attempt, when the caller asked for it. */
	rawFile: string | null;
}>;

/** One persisted run result. */
export type RunResultType = Readonly<{
	recordType: 'result';
	schemaVersion: string;
	campaignId: string;
	identity: ExecutionIdentityType;
	identityDigest: string;
	attempt: number;
	caseId: string;
	caseClass: CaseClassType;
	treatment: string;
	treatmentDefinitionHash: string;
	repetition: number;
	model: string;
	revision: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** Hard wall-clock bound declared by the case. */
	timeoutMs: number;
	outcome: OutcomeType;
	/** Harness-detected invalidity causes recorded at write time. */
	defects: readonly DefectType[];
	/** Subject and client isolation verified for this execution. */
	isolation: ExecutionIsolationType;
	/** Artifact identities associated with this execution. */
	artifacts: RunArtifactsType;
	usage: RunEventsType['usage'];
	/** Exact-or-unavailable token and cost metrics; never estimated from bytes. */
	telemetry: TelemetryType;
	/** Normalized calls in stream order, including nested, unknown, and failed calls. */
	toolCalls: RunEventsType['toolCalls'];
	outputBytes: number;
	/** Summed output bytes per tool family. */
	familyBytes: RunEventsType['familyBytes'];
	/** Raw event lines examined and malformed lines retained for diagnosis. */
	rawEventCount: number;
	malformedEventCount: number;
	/** True when the captured stream ended in a truncated or malformed line. */
	streamTruncated: boolean;
	indexCalls: number;
	/** Exact tool-name surface captured before this execution. */
	surface: ToolSurfaceType;
	/** Observed routing, including every unknown-tool outcome. */
	routing: RoutingType;
	errors: readonly string[];
	grade: GradeType;
	workflow: WorkflowResultType;
	/** Declared deterministic post-run command result; null when none was declared. */
	postRun: PostRunResultType | null;
	valid: boolean;
	invalidReason: string | null;
	/** True when the accepted attempt was throttled and retried. */
	rateLimited: boolean;
	/** Every attempt, including discarded throttled executions. */
	attempts: readonly AttemptLogType[];
	finalText: string;
	stderrTail: string;
}>;

/** Facts derived from one completed attempt, recorded in its result. */
export type AttemptContextType = Readonly<{
	attempt: number;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	timeoutMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	outcome: OutcomeType;
	invalidReason: string | null;
	events: RunEventsType;
	routing: RoutingType;
	grade: GradeType;
	workflow: WorkflowResultType;
	postRun: PostRunResultType | null;
	throttled: boolean;
	rawFile: string | null;
	stderr: string;
}>;
