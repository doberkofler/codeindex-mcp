import {type EconomicAnalysisType, economicAnalysisOf, latencyStudyOf, type LatencyStudyType} from './economicAnalysis.ts';
import {type EconomicExecutionType, meanOf, percentileOf, weightedMeanOf} from './costStudy.ts';
import {rngOf} from './bootstrapRng.ts';
import {EVALUATION_CONTRACT, type EconomicContractType} from './economicContract.ts';
import {hashOf} from './hash.ts';
import {ratioOf, type RatioType} from './ratio.ts';
import {type RunResultType} from './runTypes.ts';
import {type CertificationBlockType, type CertificationCaseType, type CertificationDesignType} from './certificationDesign.ts';
import {type CertificationPlanType} from './certificationPlan.ts';
import {
	certificationSummaryOf,
	certificationTrajectoryOf,
	type CertificationExpectationType,
	type CertificationTrajectorySummaryType,
	type CertificationTrajectoryType,
	slotKeyOf,
} from './certificationTrajectory.ts';

/** One planned slot and its validity state. */
export type CertificationSlotType = Readonly<{
	caseId: string;
	treatment: string;
	repetition: number;
	status: 'valid' | 'invalid';
	cause: string | null;
}>;

/** Token components retained for one arm. */
export type CertificationTokenComponentsType = Readonly<{
	nonCachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: Readonly<Record<string, number>>;
	visibleOutputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
}>;

/** Aggregate provider token components for one arm. */
export type CertificationTokenTotalsType = Readonly<{
	treatment: string;
	exactExecutions: number;
	components: CertificationTokenComponentsType | null;
	requestKinds: Readonly<Record<string, number>>;
}>;

/** Agent-only cost arithmetic retained as sensitivity evidence. */
export type CertificationAgentOnlyType = Readonly<{
	state: 'exact' | 'unavailable';
	baselineMeanUsd: number | null;
	treatmentMeanUsd: number | null;
	ratio: RatioType;
	oneSidedUpper95: number | null;
	oneSidedUpperState: 'bounded' | 'unbounded' | 'unavailable';
	reason: string | null;
}>;

/** Reliability facts kept separate from cost and correctness. */
export type CertificationReliabilityType = Readonly<{
	plannedExecutions: number;
	storedExecutions: number;
	validExecutions: number;
	invalidExecutions: number;
	exactMetering: number;
	requestOnePresent: number;
	pathClean: boolean;
	unknownToolRuns: number;
	restorationFailures: number;
	retriedSlots: number;
	failedAttempts: number;
	timedOut: number;
}>;

/** Campaign identity and artifacts appended to one block. */
export type CertificationCampaignType = Readonly<{
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

/** Complete evidence for one fixed or descriptive block. */
export type CertificationBlockReportType = Readonly<{
	id: CertificationBlockType['id'];
	role: CertificationBlockType['role'];
	claimAuthority: 'release-gate' | 'descriptive';
	suite: CertificationBlockType['suite'];
	cases: readonly CertificationCaseType[];
	repetitions: number;
	weights: Readonly<Record<string, number>>;
	campaign: CertificationCampaignType | null;
	plan: Readonly<{seed: string; sourceDigest: string; plannedExecutions: number}>;
	slots: readonly CertificationSlotType[];
	trajectories: readonly CertificationTrajectoryType[];
	trajectorySummary: readonly CertificationTrajectorySummaryType[];
	economic: EconomicAnalysisType;
	agentOnly: CertificationAgentOnlyType;
	tokens: readonly CertificationTokenTotalsType[];
	latency: LatencyStudyType;
	reliability: CertificationReliabilityType;
	passed: boolean;
	blocking: readonly string[];
}>;

/** One executed block and its randomized plan. */
export type CertificationBlockInputType = Readonly<{
	block: CertificationBlockType;
	plan: CertificationPlanType;
	runs: readonly RunResultType[];
}>;

const runsBySlotOf = (block: CertificationBlockType, plan: CertificationPlanType, runs: readonly RunResultType[]): ReadonlyMap<string, RunResultType> => {
	if (plan.blockId !== block.id) {
		throw new Error(`certification plan ${plan.blockId} does not belong to block ${block.id}`);
	}

	const bySlot = new Map<string, RunResultType>();

	for (const run of runs) {
		const key = slotKeyOf(run.caseId, run.treatment, run.repetition);

		if (bySlot.has(key)) {
			throw new Error(`certification block ${block.id} contains duplicate slot ${run.caseId}/${run.treatment}/rep-${run.repetition}`);
		}

		bySlot.set(key, run);
	}

	const planned = new Set(plan.plan.map((entry) => slotKeyOf(entry.caseId, entry.treatment, entry.repetition)));
	const unexpected = [...bySlot.keys()].filter((key) => !planned.has(key));

	if (unexpected.length > 0) {
		throw new Error(`certification block ${block.id} contains ${unexpected.length} unplanned execution(s)`);
	}

	return bySlot;
};

const slotsAndTrajectoriesOf = (
	block: CertificationBlockType,
	plan: CertificationPlanType,
	bySlot: ReadonlyMap<string, RunResultType>,
	expectation: CertificationExpectationType,
): Readonly<{slots: readonly CertificationSlotType[]; trajectories: readonly CertificationTrajectoryType[]}> => {
	const trajectories: CertificationTrajectoryType[] = [];
	const slots: CertificationSlotType[] = [];

	for (const entry of plan.plan) {
		const run = bySlot.get(slotKeyOf(entry.caseId, entry.treatment, entry.repetition));

		if (run === undefined) {
			slots.push({caseId: entry.caseId, treatment: entry.treatment, repetition: entry.repetition, status: 'invalid', cause: 'missing-execution'});
			continue;
		}

		const trajectory = certificationTrajectoryOf(run, block.id, expectation);
		trajectories.push(trajectory);
		slots.push({
			caseId: entry.caseId,
			treatment: entry.treatment,
			repetition: entry.repetition,
			status: trajectory.valid ? 'valid' : 'invalid',
			cause: trajectory.valid ? null : trajectory.causes.join('; '),
		});
	}

	return {slots, trajectories};
};

const executionsOf = (runs: readonly RunResultType[], trajectories: readonly CertificationTrajectoryType[]): readonly EconomicExecutionType[] => {
	const valid = new Map(trajectories.map((trajectory) => [slotKeyOf(trajectory.caseId, trajectory.treatment, trajectory.repetition), trajectory.valid]));

	return runs.map((run) => ({
		caseId: run.caseId,
		caseClass: run.caseClass,
		treatment: run.treatment,
		repetition: run.repetition,
		valid: valid.get(slotKeyOf(run.caseId, run.treatment, run.repetition)) === true,
		correct: run.grade.success,
		falseAbsence: run.grade.falseAbsence,
		timedOut: run.timedOut,
		durationMs: run.durationMs,
		timeoutMs: run.timeoutMs,
		costUsd: run.providerCost?.state === 'exact' ? run.providerCost.totalUsd : null,
		costState: run.providerCost?.state ?? 'unavailable',
		allToolOutputBytes: Object.values(run.familyBytes).reduce((total, value) => total + value, 0),
		toolOutputByFamily: run.familyBytes,
	}));
};

const validOf = (trajectories: readonly CertificationTrajectoryType[]): ReadonlyMap<string, boolean> =>
	new Map(trajectories.map((trajectory) => [slotKeyOf(trajectory.caseId, trajectory.treatment, trajectory.repetition), trajectory.valid]));

const agentOnlyOf = (
	runs: readonly RunResultType[],
	valid: ReadonlyMap<string, boolean>,
	weights: Readonly<Record<string, number>>,
	seed: string,
): CertificationAgentOnlyType => {
	const valuesOf = (caseId: string, treatment: string): readonly number[] =>
		runs
			.filter(
				(run) =>
					run.caseId === caseId &&
					run.treatment === treatment &&
					run.providerCost?.state === 'exact' &&
					valid.get(slotKeyOf(run.caseId, run.treatment, run.repetition)) === true,
			)
			.map((run) => run.providerCost?.agentOnlyUsd)
			.filter((value): value is number => value !== null && value !== undefined);
	const pairs = Object.keys(weights).flatMap((caseId) => {
		const baseline = valuesOf(caseId, 'no-index');
		const treatment = valuesOf(caseId, 'candidate');

		return baseline.length === 0 || treatment.length === 0 ? [] : [{caseId, baseline: meanOf(baseline), treatment: meanOf(treatment)}];
	});

	if (pairs.length === 0) {
		return {
			state: 'unavailable',
			baselineMeanUsd: null,
			treatmentMeanUsd: null,
			ratio: {state: 'finite', value: null},
			oneSidedUpper95: null,
			oneSidedUpperState: 'unavailable',
			reason: 'no paired agent-only cost vector',
		};
	}

	const baseline = weightedMeanOf(pairs, weights, 'baseline');
	const treatment = weightedMeanOf(pairs, weights, 'treatment');
	const ratio = ratioOf(treatment, baseline);
	const random = rngOf(seed);
	const draws: number[] = [];
	let unbounded = false;

	for (let resample = 0; resample < EVALUATION_CONTRACT.confidence.resamples; resample += 1) {
		const drawn = Array.from({length: pairs.length}, () => pairs[Math.floor(random() * pairs.length)]).filter(
			(pair): pair is (typeof pairs)[number] => pair !== undefined,
		);
		const draw = ratioOf(weightedMeanOf(drawn, weights, 'treatment'), weightedMeanOf(drawn, weights, 'baseline'));

		if (draw.state === 'positive-over-zero') {
			unbounded = true;
		} else if (draw.value !== null) {
			draws.push(draw.value);
		}
	}

	const upper = unbounded || draws.length === 0 ? null : percentileOf(draws, EVALUATION_CONTRACT.cost.confidence);

	return {
		state: 'exact',
		baselineMeanUsd: baseline,
		treatmentMeanUsd: treatment,
		ratio,
		oneSidedUpper95: upper,
		oneSidedUpperState: unbounded ? 'unbounded' : upper === null ? 'unavailable' : 'bounded',
		reason: null,
	};
};

const emptyTokens = (): CertificationTokenComponentsType => ({
	nonCachedInputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: {},
	visibleOutputTokens: 0,
	reasoningTokens: 0,
	totalTokens: 0,
});

const addComponentsOf = (total: CertificationTokenComponentsType, run: RunResultType): CertificationTokenComponentsType => {
	const current = run.providerCost?.components;

	if (current === null || current === undefined) {
		return total;
	}

	const writes: Record<string, number> = {...total.cacheWriteTokens};

	for (const [name, value] of Object.entries(current.cacheWriteTokens)) {
		writes[name] = (writes[name] ?? 0) + value;
	}

	const cacheWriteTotal = Object.values(current.cacheWriteTokens).reduce((sum, value) => sum + value, 0);

	return {
		nonCachedInputTokens: total.nonCachedInputTokens + current.nonCachedInputTokens,
		cacheReadTokens: total.cacheReadTokens + current.cacheReadTokens,
		cacheWriteTokens: writes,
		visibleOutputTokens: total.visibleOutputTokens + current.visibleOutputTokens,
		reasoningTokens: total.reasoningTokens + current.reasoningTokens,
		totalTokens:
			total.totalTokens + current.nonCachedInputTokens + current.cacheReadTokens + cacheWriteTotal + current.visibleOutputTokens + current.reasoningTokens,
	};
};

const tokenTotalsOf = (runs: readonly RunResultType[], valid: ReadonlyMap<string, boolean>, treatment: string): CertificationTokenTotalsType => {
	const selected = runs.filter(
		(run) =>
			run.treatment === treatment &&
			run.providerCost?.state === 'exact' &&
			run.providerCost.components !== null &&
			valid.get(slotKeyOf(run.caseId, run.treatment, run.repetition)) === true,
	);
	const requestKinds: Record<string, number> = {};

	for (const run of selected) {
		for (const [kind, count] of Object.entries(run.providerCost?.requestKinds ?? {})) {
			requestKinds[kind] = (requestKinds[kind] ?? 0) + count;
		}
	}

	if (selected.length === 0) {
		return {treatment, exactExecutions: 0, components: null, requestKinds};
	}

	return {treatment, exactExecutions: selected.length, components: selected.reduce((total, run) => addComponentsOf(total, run), emptyTokens()), requestKinds};
};

const campaignOf = (runs: readonly RunResultType[]): CertificationCampaignType | null => {
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

const contractOf = (weights: Readonly<Record<string, number>>, design: CertificationDesignType): EconomicContractType => ({
	...EVALUATION_CONTRACT,
	suite: {...EVALUATION_CONTRACT.suite, caseWeights: weights},
	cost: {...EVALUATION_CONTRACT.cost, targetRatio: design.thresholds.costRatioTarget, confidence: design.thresholds.confidence},
	correctness: {...EVALUATION_CONTRACT.correctness, nonInferiorityMargin: design.thresholds.nonInferiorityMargin},
	latency: {...EVALUATION_CONTRACT.latency, timeoutCeilingMs: design.thresholds.timeoutCeilingMs},
});

const reliabilityOf = (
	runs: readonly RunResultType[],
	slots: readonly CertificationSlotType[],
	trajectories: readonly CertificationTrajectoryType[],
): CertificationReliabilityType => {
	const invalid = slots.filter((slot) => slot.status === 'invalid');

	return {
		plannedExecutions: slots.length,
		storedExecutions: runs.length,
		validExecutions: slots.filter((slot) => slot.status === 'valid').length,
		invalidExecutions: invalid.length,
		exactMetering: trajectories.filter((trajectory) => trajectory.costState === 'exact').length,
		requestOnePresent: trajectories.filter((trajectory) => trajectory.requestOne.state === 'present').length,
		pathClean: trajectories.every((trajectory) => !trajectory.causes.includes('path-contamination')),
		unknownToolRuns: trajectories.filter((trajectory) => trajectory.causes.some((cause) => cause.startsWith('unknown-tools:'))).length,
		restorationFailures: trajectories.filter((trajectory) => trajectory.causes.includes('isolation-not-restored')).length,
		retriedSlots: runs.filter((run) => run.attempts.length > 1).length,
		failedAttempts: runs.reduce((total, run) => total + run.attempts.filter((attempt) => attempt.invalidReason !== null).length, 0),
		timedOut: runs.filter((run) => run.timedOut).length,
	};
};

const validityBlockingOf = (
	slots: readonly CertificationSlotType[],
	runs: readonly RunResultType[],
	reliability: CertificationReliabilityType,
): readonly string[] => {
	const invalid = slots.filter((slot) => slot.status === 'invalid');
	const blocking: string[] = [];

	if (invalid.length > 0) {
		blocking.push(
			`${invalid.length}/${slots.length} planned execution(s) invalid: ${invalid.map((slot) => `${slot.caseId}/${slot.treatment}/rep-${slot.repetition} (${slot.cause ?? 'unknown'})`).join(', ')}`,
		);
	}

	if (reliability.exactMetering !== runs.length) {
		blocking.push(`${runs.length - reliability.exactMetering} stored execution(s) lack an exact provider cost vector`);
	}

	if (reliability.requestOnePresent !== runs.length) {
		blocking.push(`${runs.length - reliability.requestOnePresent} stored execution(s) lack the declared request-1 surface`);
	}

	if (!reliability.pathClean) {
		blocking.push('path contamination was observed in at least one execution');
	}

	if (reliability.unknownToolRuns > 0) {
		blocking.push(`${reliability.unknownToolRuns} execution(s) called an unknown tool`);
	}

	if (reliability.restorationFailures > 0) {
		blocking.push(`${reliability.restorationFailures} execution(s) failed workspace restoration`);
	}

	return blocking;
};

const economicBlockingOf = (block: CertificationBlockType, economic: EconomicAnalysisType): readonly string[] => {
	const blocking: string[] = [];

	if (!economic.correctness.gate.passed) {
		blocking.push(`paired correctness gate failed: ${economic.correctness.gate.detail}`);
	}

	if (economic.correctness.falseAbsenceCount > 0) {
		blocking.push(`${economic.correctness.falseAbsenceCount} candidate false absence(s)`);
	}

	// The primary block carries the release-gate cost target. The holdout block
	// is a disjoint descriptive replication and never changes the frozen impact
	// population, so its cost estimate is reported but not gated.
	if (block.id === 'primary' && !economic.cost.gate.passed) {
		blocking.push(`cost gate failed: ${economic.cost.gate.detail}`);
	}

	return blocking;
};

/**
 * Builds the complete evidence record for one certification block.
 *
 * Every planned slot is either valid or carries closed causes. Missing and
 * unexpected executions are retained as evidence, never silently dropped.
 *
 * @param input - Frozen block, randomized plan, stored runs, and design.
 * @returns Block evidence and its closed gate result.
 */
export const certificationBlockReportOf = (
	input: Readonly<{
		block: CertificationBlockType;
		plan: CertificationPlanType;
		runs: readonly RunResultType[];
		design: CertificationDesignType;
	}>,
): CertificationBlockReportType => {
	const {block, plan, runs, design} = input;
	const expectation: CertificationExpectationType = {
		modelReference: design.model.reference,
		candidateDigest: design.artifacts.candidate.digest,
		tariffDigest: design.tariff.digest,
		timeoutCeilingMs: design.thresholds.timeoutCeilingMs,
	};
	const bySlot = runsBySlotOf(block, plan, runs);
	const {slots, trajectories} = slotsAndTrajectoriesOf(block, plan, bySlot, expectation);
	const weights = Object.fromEntries(block.cases.map((testCase) => [testCase.id, testCase.weight]));
	const executions = executionsOf(runs, trajectories);
	const economic = economicAnalysisOf(
		executions,
		contractOf(weights, design),
		hashOf({purpose: 'certification-economic', design: design.digest, block: block.id}),
	);
	const valid = validOf(trajectories);
	const reliability = reliabilityOf(runs, slots, trajectories);
	const blocking = [...validityBlockingOf(slots, runs, reliability), ...economicBlockingOf(block, economic)];

	if (runs.length !== slots.length) {
		blocking.push(`${slots.length - runs.length} planned execution(s) missing`);
	}

	return {
		id: block.id,
		role: block.role,
		claimAuthority: block.id === 'primary' ? 'release-gate' : 'descriptive',
		suite: block.suite,
		cases: block.cases,
		repetitions: block.repetitions,
		weights,
		campaign: campaignOf(runs),
		plan: {seed: plan.seed, sourceDigest: plan.sourceDigest, plannedExecutions: plan.plan.length},
		slots,
		trajectories,
		trajectorySummary: [certificationSummaryOf('no-index', trajectories), certificationSummaryOf('candidate', trajectories)],
		economic,
		agentOnly: agentOnlyOf(runs, valid, weights, hashOf({purpose: 'certification-agent-only', design: design.digest, block: block.id})),
		tokens: [tokenTotalsOf(runs, valid, 'no-index'), tokenTotalsOf(runs, valid, 'candidate')],
		latency: latencyStudyOf(executions, design.thresholds.timeoutCeilingMs),
		reliability,
		passed: blocking.length === 0,
		blocking,
	};
};
