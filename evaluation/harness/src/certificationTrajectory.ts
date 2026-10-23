import {hashOf} from './hash.ts';
import {type RunResultType} from './runTypes.ts';
import {presentedToolsOf} from './surface.ts';
import {type CertificationBlockType} from './certificationDesign.ts';

/** One sanitized provider request retained in a certification trajectory. */
export type CertificationRequestType = Readonly<{
	ordinal: number;
	kind: string;
	provider: string;
	model: string | null;
	startedAt: string;
	completedAt: string | null;
	toolNames: readonly string[];
	requestBytes: number;
	responseBytes: number | null;
	status: 'completed' | 'failed' | 'pending';
	failureCause: string | null;
	costUsd: number | null;
	costState: 'exact' | 'unavailable' | 'not-applicable';
}>;

/** Request-1 classification for one certification execution. */
export type CertificationRequestOneType = Readonly<{
	state: 'present' | 'missing' | 'surface-mismatch';
	kind: string | null;
	tools: readonly string[];
	codeIndexTools: readonly string[];
	ordinaryTools: readonly string[];
	reason: string | null;
}>;

/** Index contribution and authoritative-stop behavior for one execution. */
export type CertificationIndexBehaviorType = Readonly<{
	indexCalls: number;
	completedIndexCalls: number;
	authoritativeCalls: number;
	firstIndexTool: string | null;
	indexOutputBytes: number;
	ordinaryRetrievalCallsAfterFirstIndex: number;
	fallbacksAfterAuthoritative: number;
	authoritativeStop: 'authoritative-stop' | null;
	indexContribution: 'none' | 'non-authoritative' | 'authoritative';
}>;

/** One retained execution with its closed validity causes. */
export type CertificationTrajectoryType = Readonly<{
	blockId: CertificationBlockType['id'];
	caseId: string;
	caseClass: string;
	treatment: string;
	repetition: number;
	attempt: number;
	valid: boolean;
	causes: readonly string[];
	correct: boolean;
	falseAbsence: boolean;
	outcome: string;
	durationMs: number;
	totalUsd: number | null;
	agentOnlyUsd: number | null;
	costState: 'exact' | 'unavailable' | 'not-applicable';
	agentRequests: number;
	requestKinds: Readonly<Record<string, number>>;
	requestOne: CertificationRequestOneType;
	index: CertificationIndexBehaviorType;
	requests: readonly CertificationRequestType[];
	toolSequence: readonly string[];
}>;

/** Aggregate trajectory classification across one treatment. */
export type CertificationTrajectorySummaryType = Readonly<{
	treatment: string;
	executions: number;
	valid: number;
	requestOnePresent: number;
	indexUsed: number;
	authoritativeResults: number;
	authoritativeStops: number;
	fallbacksAfterAuthoritative: number;
	ordinaryFallbackRuns: number;
	exactCostVectors: number;
	requestKinds: Readonly<Record<string, number>>;
}>;

/** Expected immutable facts every execution must satisfy. */
export type CertificationExpectationType = Readonly<{
	modelReference: string;
	acceptedDigest: string;
	candidateDigest: string;
	tariffDigest: string;
	timeoutCeilingMs: number;
}>;

const FIRST_INDEX_RETRIEVAL_FAMILIES = new Set(['search', 'read', 'list', 'execute']);

const codeIndexToolOf = (tool: string): boolean => tool.startsWith('codeindex_');

const requestOneOf = (run: RunResultType): CertificationRequestOneType => {
	// The declaration is about the first agent request, not a literal ordinal.
	// OpenCode can emit an auxiliary `other` request before the agent turn.
	const agent = run.providerMeter?.requests.find((request) => request.kind === 'agent');
	const tools = agent?.toolNames ?? [];
	const codeIndexTools = tools.filter((tool) => codeIndexToolOf(tool));
	const ordinaryTools = tools.filter((tool) => !codeIndexToolOf(tool));
	const expected = presentedToolsOf(run.surface);

	if (agent === undefined) {
		return {
			state: 'missing',
			kind: null,
			tools,
			codeIndexTools,
			ordinaryTools,
			reason: 'the task made no agent request',
		};
	}

	const missing = expected.filter((name) => !tools.includes(name));
	const unexpected = tools.filter((name) => !expected.includes(name));

	if (missing.length > 0 || unexpected.length > 0) {
		return {
			state: 'surface-mismatch',
			kind: agent.kind,
			tools,
			codeIndexTools,
			ordinaryTools,
			reason: `request-1 tools do not match the declared ${run.treatment} surface`,
		};
	}

	return {state: 'present', kind: agent.kind, tools, codeIndexTools, ordinaryTools, reason: null};
};

const indexBehaviorOf = (run: RunResultType): CertificationIndexBehaviorType => {
	const calls = run.toolCalls.filter((call) => call.family === 'index');
	const completed = calls.filter((call) => call.status === 'completed');
	const authoritative = calls.filter((call) => call.authoritative === true);
	const [first] = calls;
	const ordinaryAfter =
		first === undefined ? 0 : run.toolCalls.filter((call) => call.index > first.index && FIRST_INDEX_RETRIEVAL_FAMILIES.has(call.family)).length;
	const authoritativeStop = authoritative.length > 0 && run.workflow.fallbacksAfterAuthoritative === 0;

	return {
		indexCalls: calls.length,
		completedIndexCalls: completed.length,
		authoritativeCalls: authoritative.length,
		firstIndexTool: first?.tool ?? null,
		indexOutputBytes: run.familyBytes.index,
		ordinaryRetrievalCallsAfterFirstIndex: ordinaryAfter,
		fallbacksAfterAuthoritative: run.workflow.fallbacksAfterAuthoritative,
		authoritativeStop: authoritativeStop ? 'authoritative-stop' : null,
		indexContribution: authoritative.length > 0 ? 'authoritative' : calls.length > 0 ? 'non-authoritative' : 'none',
	};
};

const requestTrajectoryOf = (run: RunResultType): readonly CertificationRequestType[] => {
	const costs = new Map((run.providerCost?.requests ?? []).map((request) => [request.ordinal, request]));

	return (run.providerMeter?.requests ?? []).map((request) => {
		const cost = costs.get(request.ordinal);

		return {
			ordinal: request.ordinal,
			kind: request.kind,
			provider: request.provider,
			model: request.model,
			startedAt: request.startedAt,
			completedAt: request.completedAt,
			toolNames: request.toolNames,
			requestBytes: request.requestBytes,
			responseBytes: request.responseBytes,
			status: request.status,
			failureCause: request.failureCause,
			costUsd: cost?.costUsd ?? null,
			costState: cost?.state ?? 'unavailable',
		};
	});
};

const requestKindsOf = (requests: readonly CertificationRequestType[]): Readonly<Record<string, number>> => {
	const kinds: Record<string, number> = {};

	for (const request of requests) {
		kinds[request.kind] = (kinds[request.kind] ?? 0) + 1;
	}

	return kinds;
};

const isolationCausesOf = (run: RunResultType): readonly string[] => {
	const causes: string[] = [];

	if (!run.valid) {
		causes.push(run.invalidReason ?? 'invalid-execution');
	}

	causes.push(...run.defects);

	if (run.outcome !== 'completed') {
		causes.push(`outcome-${run.outcome}`);
	}

	if (!run.isolation.checkoutClean || !run.isolation.revisionMatch || !run.isolation.restored) {
		causes.push('isolation-not-restored');
	}

	return causes;
};

const meteringCausesOf = (run: RunResultType): readonly string[] => {
	const causes: string[] = [];

	if (run.providerCost === null || run.providerCost === undefined || run.providerCost.state !== 'exact') {
		causes.push('incomplete-metering');
	}

	if (run.providerMeter === null || run.providerMeter === undefined) {
		causes.push('missing-provider-meter');

		return causes;
	}

	if (!run.providerMeter.settledExactlyOnce) {
		causes.push('provider-requests-not-settled');
	}

	if (!run.providerMeter.pathClean || (run.externalPathAttemptCount ?? 0) > 0) {
		causes.push('path-contamination');
	}

	return causes;
};

const surfaceCausesOf = (run: RunResultType, requestOne: CertificationRequestOneType): readonly string[] => {
	const causes: string[] = [];

	if (requestOne.state !== 'present') {
		causes.push(`request-1-${requestOne.state}`);
	}

	if (run.routing.unknownTools.length > 0) {
		causes.push(`unknown-tools:${run.routing.unknownTools.join(',')}`);
	}

	if (!run.routing.native || run.routing.executeCalls > 0) {
		causes.push('non-native-exposure');
	}

	return causes;
};

const identityCausesOf = (run: RunResultType, expectation: CertificationExpectationType): readonly string[] => {
	const causes: string[] = [];
	const {accepted, candidate} = run.artifacts;

	if (run.model !== expectation.modelReference) {
		causes.push('model-mismatch');
	}

	if (accepted === null || accepted.digest !== expectation.acceptedDigest) {
		causes.push('accepted-artifact-mismatch');
	}

	if (candidate === null || candidate.digest !== expectation.candidateDigest) {
		causes.push('candidate-artifact-mismatch');
	}

	if (run.providerCost !== null && run.providerCost !== undefined && hashOf(run.providerCost.tariff) !== expectation.tariffDigest) {
		causes.push('tariff-mismatch');
	}

	if (run.timeoutMs > expectation.timeoutCeilingMs) {
		causes.push('timeout-ceiling-exceeded');
	}

	return causes;
};

/**
 * Derives every closed validity cause for one stored execution.
 *
 * The causes cover incomplete metering, request-1 surface, path contamination,
 * unknown tools, non-native exposure, isolation, model identity, artifact
 * identity, and the tariff snapshot. An empty result is the only valid state.
 *
 * @param run - Stored execution.
 * @param expectation - Frozen identity the execution must reproduce.
 * @param requestOne - Request-1 classification for the execution.
 * @returns Sorted, unique closed causes.
 */
export const certificationCausesOf = (
	run: RunResultType,
	expectation: CertificationExpectationType,
	requestOne: CertificationRequestOneType,
): readonly string[] =>
	[...new Set([...isolationCausesOf(run), ...meteringCausesOf(run), ...surfaceCausesOf(run, requestOne), ...identityCausesOf(run, expectation)])].sort();

/**
 * Builds the sanitized trajectory for one stored execution.
 *
 * @param run - Stored execution.
 * @param blockId - Certification block that planned the execution.
 * @param expectation - Frozen identity the execution must reproduce.
 * @returns The trajectory with its closed validity causes.
 */
export const certificationTrajectoryOf = (
	run: RunResultType,
	blockId: CertificationBlockType['id'],
	expectation: CertificationExpectationType,
): CertificationTrajectoryType => {
	const requests = requestTrajectoryOf(run);
	const requestOne = requestOneOf(run);
	const causes = certificationCausesOf(run, expectation, requestOne);

	return {
		blockId,
		caseId: run.caseId,
		caseClass: run.caseClass,
		treatment: run.treatment,
		repetition: run.repetition,
		attempt: run.attempt,
		valid: causes.length === 0,
		causes,
		correct: run.grade.success,
		falseAbsence: run.grade.falseAbsence,
		outcome: run.outcome,
		durationMs: run.durationMs,
		totalUsd: run.providerCost?.state === 'exact' ? run.providerCost.totalUsd : null,
		agentOnlyUsd: run.providerCost?.state === 'exact' ? run.providerCost.agentOnlyUsd : null,
		costState: run.providerCost?.state ?? 'unavailable',
		agentRequests: requests.filter((request) => request.kind === 'agent').length,
		requestKinds: requestKindsOf(requests),
		requestOne,
		index: indexBehaviorOf(run),
		requests,
		toolSequence: run.toolCalls.map((call) => call.tool),
	};
};

/**
 * Summarizes one treatment's trajectories.
 *
 * @param treatment - Treatment id.
 * @param trajectories - All trajectories in the block.
 * @returns Counts for validity, surface, index contribution, and cost.
 */
export const certificationSummaryOf = (treatment: string, trajectories: readonly CertificationTrajectoryType[]): CertificationTrajectorySummaryType => {
	const selected = trajectories.filter((trajectory) => trajectory.treatment === treatment);
	const requestKinds: Record<string, number> = {};

	for (const trajectory of selected) {
		for (const [kind, count] of Object.entries(trajectory.requestKinds)) {
			requestKinds[kind] = (requestKinds[kind] ?? 0) + count;
		}
	}

	return {
		treatment,
		executions: selected.length,
		valid: selected.filter((trajectory) => trajectory.valid).length,
		requestOnePresent: selected.filter((trajectory) => trajectory.requestOne.state === 'present').length,
		indexUsed: selected.filter((trajectory) => trajectory.index.indexCalls > 0).length,
		authoritativeResults: selected.filter((trajectory) => trajectory.index.authoritativeCalls > 0).length,
		authoritativeStops: selected.filter((trajectory) => trajectory.index.authoritativeStop !== null).length,
		fallbacksAfterAuthoritative: selected.reduce((total, trajectory) => total + trajectory.index.fallbacksAfterAuthoritative, 0),
		ordinaryFallbackRuns: selected.filter((trajectory) => trajectory.index.ordinaryRetrievalCallsAfterFirstIndex > 0).length,
		exactCostVectors: selected.filter((trajectory) => trajectory.costState === 'exact').length,
		requestKinds,
	};
};

/**
 * Builds a stable key for one planned execution slot.
 *
 * @param caseId - Case id.
 * @param treatment - Treatment id.
 * @param repetition - One-based paired repetition.
 * @returns A collision-free slot key.
 */
export const slotKeyOf = (caseId: string, treatment: string, repetition: number): string => `${caseId}\u0000${treatment}\u0000${repetition}`;
