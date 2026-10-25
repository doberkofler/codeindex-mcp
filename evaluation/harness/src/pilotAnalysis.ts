import {type EconomicAnalysisType, economicAnalysisOf, latencyStudyOf} from './economicAnalysis.ts';
import {type EconomicExecutionType, economicExecutionsOf} from './costStudy.ts';
import {EVALUATION_CONTRACT, type EconomicContractType} from './economicContract.ts';
import {hashOf} from './hash.ts';
import {type PilotDesignType} from './pilotDesign.ts';
import {type RunResultType} from './runTypes.ts';
import {CASE_CLASSES} from './schema.ts';
import {presentedToolsOf} from './surface.ts';

import {
	type PilotCampaignType,
	type PilotClassSummaryType,
	type PilotDecisionRecordType,
	type PilotIndexBehaviorType,
	type PilotReportType,
	type PilotRequestOneType,
	type PilotRequestType,
	type PilotTrajectorySummaryType,
	type PilotTrajectoryType,
} from './pilotTypes.ts';

const codeIndexToolOf = (tool: string): boolean => tool.startsWith('codeindex_');

const FIRST_INDEX_RETRIEVAL_FAMILIES = new Set(['search', 'read', 'list', 'execute']);

const requestOneOf = (run: RunResultType): PilotRequestOneType => {
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

const indexBehaviorOf = (run: RunResultType): PilotIndexBehaviorType => {
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

const requestTrajectoryOf = (run: RunResultType): readonly PilotRequestType[] => {
	const costs = new Map((run.providerCost?.requests ?? []).map((request) => [request.ordinal, request]));

	return (run.providerMeter?.requests ?? []).map((request) => {
		const cost = costs.get(request.ordinal);

		return {
			ordinal: request.ordinal,
			kind: request.kind,
			startedAt: request.startedAt,
			completedAt: request.completedAt,
			toolNames: request.toolNames,
			status: request.status,
			costUsd: cost?.costUsd ?? null,
			costState: cost?.state ?? 'unavailable',
		};
	});
};

const trajectoryOf = (run: RunResultType): PilotTrajectoryType => {
	const requests = requestTrajectoryOf(run);
	const requestKinds: Record<string, number> = {};

	for (const request of requests) {
		requestKinds[request.kind] = (requestKinds[request.kind] ?? 0) + 1;
	}

	return {
		caseId: run.caseId,
		caseClass: run.caseClass,
		treatment: run.treatment,
		repetition: run.repetition,
		attempt: run.attempt,
		valid: run.valid && run.defects.length === 0 && run.outcome !== 'aborted' && run.streamComplete,
		streamComplete: run.streamComplete,
		streamIncompleteReasons: run.streamIncompleteReasons,
		correct: run.grade.success,
		falseAbsence: run.grade.falseAbsence,
		outcome: run.outcome,
		durationMs: run.durationMs,
		totalUsd: run.providerCost?.state === 'exact' ? run.providerCost.totalUsd : null,
		agentOnlyUsd: run.providerCost?.state === 'exact' ? run.providerCost.agentOnlyUsd : null,
		costState: run.providerCost?.state ?? 'unavailable',
		agentRequests: requests.filter((request) => request.kind === 'agent').length,
		requestKinds,
		requestOne: requestOneOf(run),
		index: indexBehaviorOf(run),
		requests,
		toolSequence: run.toolCalls.map((call) => call.tool),
	};
};

const summaryOf = (treatment: string, trajectories: readonly PilotTrajectoryType[]): PilotTrajectorySummaryType => {
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
		streamsComplete: selected.filter((trajectory) => trajectory.streamComplete).length,
		requestOnePresent: selected.filter((trajectory) => trajectory.requestOne.state === 'present').length,
		requestOneMismatch: selected.filter((trajectory) => trajectory.requestOne.state !== 'present').length,
		indexUsed: selected.filter((trajectory) => trajectory.index.indexCalls > 0).length,
		authoritativeResults: selected.filter((trajectory) => trajectory.index.authoritativeCalls > 0).length,
		authoritativeStops: selected.filter((trajectory) => trajectory.index.authoritativeStop !== null).length,
		fallbacksAfterAuthoritative: selected.reduce((total, trajectory) => total + trajectory.index.fallbacksAfterAuthoritative, 0),
		ordinaryFallbackRuns: selected.filter((trajectory) => trajectory.index.ordinaryRetrievalCallsAfterFirstIndex > 0).length,
		exactCostVectors: selected.filter((trajectory) => trajectory.costState === 'exact').length,
		unavailableCostVectors: selected.filter((trajectory) => trajectory.costState !== 'exact').length,
		requestKinds,
	};
};

const classSummariesOf = (
	trajectories: readonly PilotTrajectoryType[],
	executions: readonly EconomicExecutionType[],
	contract: EconomicContractType,
	design: PilotDesignType,
): readonly PilotClassSummaryType[] =>
	CASE_CLASSES.flatMap((caseClass) => {
		const cases = design.cases.filter((testCase) => testCase.class === caseClass);

		if (cases.length === 0) {
			return [];
		}

		const total = cases.reduce((sum, testCase) => sum + testCase.weight, 0);
		const weights = Object.fromEntries(cases.map((testCase) => [testCase.id, testCase.weight / total]));
		const analysis = economicAnalysisOf(
			executions,
			{...contract, suite: {...contract.suite, caseWeights: weights}},
			hashOf({pilot: design.digest, purpose: 'pilot-class', caseClass}),
		);
		const selected = trajectories.filter((trajectory) => trajectory.caseClass === caseClass);
		const candidate = selected.filter((trajectory) => trajectory.treatment === 'candidate');

		return [
			{
				class: caseClass,
				caseIds: cases.map((testCase) => testCase.id),
				weights,
				executions: selected.length,
				valid: selected.filter((trajectory) => trajectory.valid).length,
				invalid: selected.filter((trajectory) => !trajectory.valid).length,
				costRatio: analysis.cost.ratio.value,
				costUpper95: analysis.cost.oneSidedUpper95,
				costGatePassed: analysis.cost.gate.passed,
				correctnessGatePassed: analysis.correctness.gate.passed,
				candidateSuccessRate: analysis.correctness.candidateSuccessRate,
				baselineSuccessRate: analysis.correctness.baselineSuccessRate,
				indexUsed: candidate.filter((trajectory) => trajectory.index.indexCalls > 0).length,
				authoritativeResults: candidate.filter((trajectory) => trajectory.index.authoritativeCalls > 0).length,
				authoritativeStops: candidate.filter((trajectory) => trajectory.index.authoritativeStop !== null).length,
				fallbackRuns: candidate.filter((trajectory) => trajectory.index.ordinaryRetrievalCallsAfterFirstIndex > 0).length,
			},
		];
	});

const classEvidenceOf = (classes: readonly PilotClassSummaryType[]): readonly string[] =>
	classes.map(
		(summary) =>
			`${summary.class}: cost-ratio=${summary.costRatio === null ? 'n/a' : summary.costRatio.toFixed(3)} upper=${summary.costUpper95 === null ? 'n/a' : summary.costUpper95.toFixed(3)} stops=${summary.authoritativeStops}/${summary.executions / 2} fallback-runs=${summary.fallbackRuns}/${summary.executions / 2}`,
	);

const decisionOf = (
	trajectories: readonly PilotTrajectoryType[],
	economic: EconomicAnalysisType,
	design: PilotDesignType,
	classes: readonly PilotClassSummaryType[],
): PilotDecisionRecordType => {
	const candidate = trajectories.filter((trajectory) => trajectory.treatment === 'candidate');
	const baseline = trajectories.filter((trajectory) => trajectory.treatment === 'no-index');
	const invalid = trajectories.filter((trajectory) => !trajectory.valid).length;
	const missingRequestOne = candidate.filter((trajectory) => trajectory.requestOne.state !== 'present').length;
	const indexUsed = candidate.filter((trajectory) => trajectory.index.indexCalls > 0).length;
	const authoritative = candidate.filter((trajectory) => trajectory.index.authoritativeCalls > 0).length;
	const stops = candidate.filter((trajectory) => trajectory.index.authoritativeStop !== null).length;
	const fallbackRuns = candidate.filter((trajectory) => trajectory.index.ordinaryRetrievalCallsAfterFirstIndex > 0).length;
	const exactCost = trajectories.filter((trajectory) => trajectory.costState === 'exact').length;

	if (trajectories.length === 0 || invalid > 0 || exactCost !== trajectories.length) {
		return {
			decision: 'stop',
			reason: `execution validity failed: ${invalid} invalid and ${trajectories.length - exactCost} incomplete cost vector(s)`,
			evidence: [`invalid=${invalid}`, `executions=${trajectories.length}`, `exact-cost=${exactCost}`],
		};
	}

	if (missingRequestOne > 0) {
		return {
			decision: 'redesign',
			reason: `candidate request-1 surface was missing or mismatched in ${missingRequestOne}/${candidate.length} execution(s)`,
			evidence: [`candidate-request-one=${candidate.length - missingRequestOne}/${candidate.length}`],
		};
	}

	if (economic.correctness.falseAbsenceCount > 0 || !economic.correctness.gate.passed) {
		return {
			decision: 'redesign',
			reason: `paired correctness did not meet the frozen non-inferiority margin: ${economic.correctness.gate.detail}`,
			evidence: [
				`candidate-success=${String(economic.correctness.candidateSuccessRate)}`,
				`baseline-success=${String(economic.correctness.baselineSuccessRate)}`,
			],
		};
	}

	if (economic.cost.gate.passed) {
		return {
			decision: 'continue',
			reason: `candidate met the frozen cost and correctness gates: ${economic.cost.gate.detail}`,
			evidence: [
				`cost-ratio=${String(economic.cost.ratio.value)}`,
				`cost-upper=${String(economic.cost.oneSidedUpper95)}`,
				`correctness=${economic.correctness.gate.detail}`,
			],
		};
	}

	if (candidate.length > 0 && indexUsed === candidate.length && authoritative > 0 && stops === 0) {
		return {
			decision: 'redesign',
			reason: 'the candidate index answered authoritatively but never produced an authoritative stop; ordinary fallback followed every authoritative result',
			evidence: [
				`index-used=${indexUsed}/${candidate.length}`,
				`authoritative=${authoritative}`,
				`authoritative-stops=${stops}`,
				`fallback-runs=${fallbackRuns}`,
			],
		};
	}

	if (candidate.length > 0 && indexUsed === 0) {
		return {
			decision: 'redesign',
			reason: 'the candidate never contributed an index call, so the treatment surface did not affect retrieval',
			evidence: [`index-used=0/${candidate.length}`, `baseline-executions=${baseline.length}`],
		};
	}

	return {
		decision: 'narrow-scope',
		reason: `candidate did not meet the frozen cost target without a correctness or request-1 defect; the beneficial evidence is class-specific: ${economic.cost.gate.detail}`,
		evidence: [
			`cost-ratio=${String(economic.cost.ratio.value)}`,
			`cost-upper=${String(economic.cost.oneSidedUpper95)}`,
			`index-used=${indexUsed}/${candidate.length}`,
			`authoritative-stops=${stops}`,
			`target=${design.thresholds.costRatioTarget}`,
			...classEvidenceOf(classes),
		],
	};
};

const campaignOf = (runs: readonly RunResultType[]): PilotCampaignType | null => {
	const [first] = runs;

	if (first === undefined) {
		return null;
	}

	return {
		campaignId: first.campaignId,
		identityDigest: first.identityDigest,
		harnessVersion: first.identity.harness.version,
		revision: first.identity.subject.revision,
		contentManifestHash: first.identity.subject.contentManifestHash,
		artifacts: {
			accepted: first.artifacts.accepted === null ? null : {id: first.artifacts.accepted.id, digest: first.artifacts.accepted.digest},
			candidate: first.artifacts.candidate === null ? null : {id: first.artifacts.candidate.id, digest: first.artifacts.candidate.digest},
		},
	};
};

const pilotContractOf = (design: PilotDesignType): EconomicContractType => {
	const weights = Object.fromEntries(design.cases.map((testCase) => [testCase.id, testCase.weight]));

	return {
		...EVALUATION_CONTRACT,
		suite: {...EVALUATION_CONTRACT.suite, caseWeights: weights},
		cost: {...EVALUATION_CONTRACT.cost, targetRatio: design.thresholds.costRatioTarget, confidence: EVALUATION_CONTRACT.cost.confidence},
		correctness: {...EVALUATION_CONTRACT.correctness, nonInferiorityMargin: design.thresholds.nonInferiorityMargin},
	};
};

/**
 * Builds the sanitized development-pilot record.
 *
 * Trajectories retain the ordered request kinds, offered tools, request-1
 * classification, index authority, ordinary fallback, and complete per-request
 * cost vector. The economic analysis includes every valid execution, including
 * incorrect answers, and reports paired uncertainty.
 *
 * @param input - Stored results, frozen design, and generation timestamp.
 * @returns Trajectory report and closed architecture decision.
 */
export const pilotReportOf = (input: Readonly<{runs: readonly RunResultType[]; design: PilotDesignType; generatedAt?: string}>): PilotReportType => {
	const {runs, design} = input;
	const trajectories = runs.map((run) => trajectoryOf(run));
	const economicExecutions = economicExecutionsOf(runs);
	const contract = pilotContractOf(design);
	const economic = economicAnalysisOf(economicExecutions, contract, hashOf({pilot: design.digest, purpose: 'pilot-economic'}));
	const classes = classSummariesOf(trajectories, economicExecutions, contract, design);
	const valid = trajectories.filter((trajectory) => trajectory.valid).length;

	return {
		recordType: 'development-pilot-report',
		schemaVersion: 1,
		claimClass: 'development-pilot',
		efficacyClaim: false,
		releaseAuthority: false,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		design: {id: design.id, digest: design.digest, frozenAt: design.frozenAt},
		contract: {id: design.contract.id, version: design.contract.version, digest: design.contract.digest},
		suite: {id: design.suite.id, version: design.suite.version, hash: design.suite.hash},
		campaign: campaignOf(runs),
		model: design.model,
		exposure: design.exposure,
		plan: {
			cases: design.cases,
			repetitions: design.repetitions,
			randomizationSeed: design.seed,
			plannedExecutions: design.cases.length * design.repetitions * 2,
			storedExecutions: runs.length,
			validExecutions: valid,
			invalidExecutions: runs.length - valid,
		},
		trajectories,
		trajectorySummary: [summaryOf('no-index', trajectories), summaryOf('candidate', trajectories)],
		classes,
		economic,
		latency: latencyStudyOf(economicExecutions, EVALUATION_CONTRACT.latency.timeoutCeilingMs),
		decision: decisionOf(trajectories, economic, design, classes),
	};
};
