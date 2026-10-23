import {economicExecutionsOf, meanOf, type EconomicExecutionType, fixedSuiteCostStudyOf} from './costStudy.ts';
import {pairedCorrectnessStudyOf} from './economicAnalysis.ts';
import {EVALUATION_CONTRACT, type EconomicContractType} from './economicContract.ts';
import {AA_CONFIDENCE, AA_ECONOMIC_EFFECT, aaWeightsOf, type AaArmLabelType, type AaPlanType} from './aaPlan.ts';
import {type RunResultType} from './runTypes.ts';
import {finalSampleSizeFromVarianceOf} from './sampleSizeSimulation.ts';
import {type CaseType} from './schema.ts';
import {
	type AaArmDiagnosticsType,
	type AaCalibrationInputType,
	type AaCalibrationType,
	type AaEquivalenceType,
	type AaFailureType,
	type AaPairType,
	type AaVarianceType,
} from './aaTypes.ts';

const sampleVarianceOf = (values: readonly number[]): number => {
	if (values.length < 2) {
		return 0;
	}

	const mean = meanOf(values);

	return values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
};

const failureCauseOf = (run: RunResultType): string => {
	if (run.defects.includes('external-path-attempt') || (run.externalPathAttemptCount ?? 0) > 0) {
		return 'external-path-contamination';
	}

	if (run.defects.includes('metering-incomplete') || (run.providerCost !== undefined && run.providerCost !== null && run.providerCost.state !== 'exact')) {
		return 'incomplete-metering';
	}

	if (run.timedOut) {
		return 'timeout';
	}

	if (run.outcome === 'aborted') {
		return 'aborted';
	}

	if (run.routing.unknownTools.length > 0) {
		return 'unknown-tool';
	}

	if (run.routing.executeCalls > 0) {
		return 'execute-called';
	}

	return run.valid ? 'not-a-failure' : 'invalid-execution';
};

const exactCostsOf = (runs: readonly RunResultType[]): readonly NonNullable<RunResultType['providerCost']>[] =>
	runs.flatMap((run) => {
		const cost = run.providerCost;

		return cost?.state === 'exact' ? [cost] : [];
	});

const diagnosticsOf = (arm: AaArmLabelType, runs: readonly RunResultType[]): AaArmDiagnosticsType => {
	const costs = exactCostsOf(runs);
	const sum = (valueOf: (cost: (typeof costs)[number]) => number): number => costs.reduce((total, cost) => total + valueOf(cost), 0);
	const titleCostUsd = sum((cost) => cost.requests.reduce((total, request) => total + (request.kind === 'title' ? (request.costUsd ?? 0) : 0), 0));
	const totalCostUsd = sum((cost) => cost.totalUsd ?? 0);
	const cacheReadTokens = sum((cost) => cost.components?.cacheReadTokens ?? 0);
	const nonCachedInputTokens = sum((cost) => cost.components?.nonCachedInputTokens ?? 0);
	const cacheWriteTokens = sum((cost) => Object.values(cost.components?.cacheWriteTokens ?? {}).reduce((total, value) => total + value, 0));
	const cacheDenominator = cacheReadTokens + nonCachedInputTokens;
	const metered = costs.length;

	return {
		arm,
		executions: runs.length,
		meteredExecutions: metered,
		totalCostUsd: metered === 0 ? null : totalCostUsd,
		agentOnlyCostUsd: metered === 0 ? null : sum((cost) => cost.agentOnlyUsd ?? 0),
		titleRequests: sum((cost) => cost.requestKinds['title'] ?? 0),
		titleCostUsd: metered === 0 ? null : titleCostUsd,
		titleCostShare: metered === 0 || totalCostUsd === 0 ? null : titleCostUsd / totalCostUsd,
		agentRequests: sum((cost) => cost.requestKinds['agent'] ?? 0),
		compactionRequests: sum((cost) => cost.requestKinds['compaction'] ?? 0),
		cacheReadTokens: metered === 0 ? null : cacheReadTokens,
		nonCachedInputTokens: metered === 0 ? null : nonCachedInputTokens,
		cacheWriteTokens: metered === 0 ? null : cacheWriteTokens,
		cacheHitRate: metered === 0 || cacheDenominator === 0 ? null : cacheReadTokens / cacheDenominator,
	};
};

const pairCandidatesOf = (
	input: Readonly<{cases: readonly CaseType[]; repetitionsPerCase: number; runs: readonly RunResultType[]; plan?: AaPlanType}>,
): Readonly<{pairs: readonly AaPairType[]; failures: readonly AaFailureType[]}> => {
	const bySlot = new Map(input.runs.map((run) => [`${run.caseId}/${run.repetition}`, run]));
	const pairs: AaPairType[] = [];
	const failures: AaFailureType[] = [];

	for (const testCase of input.cases) {
		for (let pair = 1; pair <= input.repetitionsPerCase; pair += 1) {
			const plannedPair = input.plan?.pairs.find((item) => item.caseId === testCase.id && item.pair === pair);
			const armARepetition = plannedPair?.armARepetition ?? (pair - 1) * 2 + 1;
			const armBRepetition = plannedPair?.armBRepetition ?? (pair - 1) * 2 + 2;
			const armA = bySlot.get(`${testCase.id}/${armARepetition}`);
			const armB = bySlot.get(`${testCase.id}/${armBRepetition}`);

			if (armA === undefined) {
				failures.push({caseId: testCase.id, pair, arm: 'a', cause: 'missing-execution', detail: `no stored result for repetition ${armARepetition}`});
			}

			if (armB === undefined) {
				failures.push({caseId: testCase.id, pair, arm: 'b', cause: 'missing-execution', detail: `no stored result for repetition ${armBRepetition}`});
			}

			if (armA !== undefined && armB !== undefined) {
				pairs.push({caseId: testCase.id, pair, first: plannedPair?.first ?? 'a', armA, armB});
			}
		}
	}

	return {pairs, failures};
};

const invalidFailuresOf = (pairs: readonly AaPairType[]): readonly AaFailureType[] =>
	pairs.flatMap((pair) =>
		(
			[
				['a', pair.armA],
				['b', pair.armB],
			] as const
		).flatMap(([arm, run]) => {
			if (!run.valid || run.defects.length > 0) {
				return [{caseId: pair.caseId, pair: pair.pair, arm, cause: failureCauseOf(run), detail: run.invalidReason ?? 'invalid execution'}];
			}

			if (run.providerCost?.state !== 'exact') {
				return [{caseId: pair.caseId, pair: pair.pair, arm, cause: 'incomplete-metering', detail: run.providerCost?.reason ?? 'no exact provider cost vector'}];
			}

			return [];
		}),
	);

const relabeledOf = (pairs: readonly AaPairType[]): readonly EconomicExecutionType[] =>
	pairs.flatMap((pair) =>
		economicExecutionsOf([pair.armA, pair.armB]).map((execution) => ({
			...execution,
			treatment: execution.repetition % 2 === 1 ? 'no-index' : 'candidate',
		})),
	);

const varianceOf = (pairs: readonly AaPairType[]): AaVarianceType & Readonly<{byCase: ReadonlyMap<string, readonly number[]>}> => {
	const exactPairs = pairs.filter(
		(pair) => pair.armA.valid && pair.armB.valid && pair.armA.providerCost?.state === 'exact' && pair.armB.providerCost?.state === 'exact',
	);
	const logRatios = exactPairs.flatMap((pair) => {
		const armACost = pair.armA.providerCost?.totalUsd ?? 0;
		const armBCost = pair.armB.providerCost?.totalUsd ?? 0;

		return armACost > 0 && armBCost > 0 ? [{caseId: pair.caseId, value: Math.log(armBCost / armACost)}] : [];
	});
	const byCase = new Map<string, number[]>();

	for (const observation of logRatios) {
		byCase.set(observation.caseId, [...(byCase.get(observation.caseId) ?? []), observation.value]);
	}

	const caseMeans = [...byCase.values()].map((values) => meanOf(values));
	const withinVariances = [...byCase.values()].map((values) => sampleVarianceOf(values));
	const within = caseMeans.length === 0 ? null : meanOf(withinVariances);
	const between = caseMeans.length < 2 ? null : sampleVarianceOf(caseMeans);
	const effectLogRatio = caseMeans.length === 0 ? null : meanOf(caseMeans);
	const icc = between === null || within === null || between + within === 0 ? null : between / (between + within);
	const replications = Math.max(1, ...[...byCase.values()].map((values) => values.length));
	const betweenCorrected = between === null || within === null ? null : Math.max(0, between - within / replications);

	return {
		withinCaseVariance: within,
		betweenCaseVariance: between,
		betweenCaseVarianceCorrected: betweenCorrected,
		effectLogRatio,
		intraclassCorrelation: icc,
		designEffect: icc === null ? null : 1 + (replications - 1) * icc,
		observations: logRatios.length,
		replications,
		byCase,
	};
};

const equivalenceReasonOf = (cost: ReturnType<typeof fixedSuiteCostStudyOf>, failures: readonly AaFailureType[], pointWithin: boolean): string | null => {
	if (failures.length > 0) {
		return `${failures.length} A/A execution(s) are missing or invalid`;
	}

	if (cost.state !== 'exact') {
		return cost.reason ?? 'cost estimate unavailable';
	}

	const lowerBound = 1 / (1 + AA_ECONOMIC_EFFECT);
	const upperBound = 1 + AA_ECONOMIC_EFFECT;

	return pointWithin ? null : `point ratio ${cost.ratio.value ?? 'unbounded'} is outside [${lowerBound.toFixed(3)}, ${upperBound.toFixed(3)}]`;
};

const equivalenceOf = (cost: ReturnType<typeof fixedSuiteCostStudyOf>, failures: readonly AaFailureType[]): AaEquivalenceType => {
	const point = cost.ratio;
	const interval = cost.twoSidedInterval95;
	const lowerBound = 1 / (1 + AA_ECONOMIC_EFFECT);
	const upperBound = 1 + AA_ECONOMIC_EFFECT;
	const intervalWithin = interval !== null && interval.low >= lowerBound && interval.high <= upperBound;
	const pointWithin = point.state === 'finite' && point.value !== null && point.value >= lowerBound && point.value <= upperBound;
	// The predeclared A/A criterion is point-ratio equivalence at the 10%
	// economic effect. The interval is retained descriptively and sizes the final
	// campaign; it does not turn a small A/A into an underpowered significance test.
	const passed = failures.length === 0 && cost.state === 'exact' && pointWithin;

	return {
		method: 'predeclared-point-ratio-equivalence',
		confidence: AA_CONFIDENCE,
		economicEffect: AA_ECONOMIC_EFFECT,
		lowerBound,
		upperBound,
		pointRatio: point,
		interval95: interval === null ? null : {low: interval.low, high: interval.high},
		intervalWithin,
		passed,
		reason: equivalenceReasonOf(cost, failures, pointWithin),
	};
};

const correctnessSampleSizeOf = (pairedDifferences: readonly number[], margin: number, caseCount: number): AaCalibrationType['sampleSize']['correctness'] => {
	if (pairedDifferences.length < 2) {
		return {
			margin,
			standardDeviation: null,
			pairsRequired: null,
			repetitions: null,
			reason: 'at least two paired cases are required to estimate success-difference variance',
		};
	}

	const standardDeviation = Math.sqrt(sampleVarianceOf(pairedDifferences));

	if (standardDeviation === 0) {
		return {margin, standardDeviation, pairsRequired: 1, repetitions: Math.ceil(1 / caseCount), reason: null};
	}

	// One-sided non-inferiority at the frozen 0.05 alpha and 0.8 power.
	const zAlpha = 1.6448536269514722;
	const zPower = 0.8416212335729143;
	const pairsRequired = Math.ceil((((zAlpha + zPower) * standardDeviation) / margin) ** 2);

	return {
		margin,
		standardDeviation,
		pairsRequired,
		repetitions: Math.max(1, Math.ceil(pairsRequired / Math.max(1, caseCount))),
		reason: null,
	};
};

const pairedSuccessDifferencesOf = (relabeled: readonly EconomicExecutionType[], caseIds: readonly string[]): readonly number[] =>
	caseIds.flatMap((caseId) => {
		const baseline = relabeled.filter((execution) => execution.caseId === caseId && execution.treatment === 'no-index' && execution.valid);
		const treatment = relabeled.filter((execution) => execution.caseId === caseId && execution.treatment === 'candidate' && execution.valid);

		if (baseline.length === 0 || treatment.length === 0) {
			return [];
		}

		const baselineRate = baseline.filter((execution) => execution.correct).length / baseline.length;
		const treatmentRate = treatment.filter((execution) => execution.correct).length / treatment.length;

		return [treatmentRate - baselineRate];
	});

const attemptCauseOf = (reason: string): string => {
	if (reason.startsWith('timed out')) {
		return 'timeout';
	}

	if (reason.includes('provider metering')) {
		return 'incomplete-metering';
	}

	if (reason.includes('external-directory')) {
		return 'external-path-contamination';
	}

	if (reason.includes('unknown tool')) {
		return 'unknown-tool';
	}

	if (reason.includes('generic execute')) {
		return 'execute-called';
	}

	return 'invalid-execution';
};
const failureSummaryOf = (
	input: Readonly<{failures: readonly AaFailureType[]; planned: number; stored: number; valid: number; runs: readonly RunResultType[]}>,
): AaCalibrationType['failureRate'] => {
	const {failures, planned, stored, valid, runs} = input;
	const byCause: Record<string, number> = {};

	for (const failure of failures) {
		byCause[failure.cause] = (byCause[failure.cause] ?? 0) + 1;
	}

	const invalidAttemptsByCause: Record<string, number> = {};
	let attempts = 0;
	let retriedExecutions = 0;

	for (const run of runs) {
		attempts += run.attempts.length;

		if (run.attempts.length > 1) {
			retriedExecutions += 1;
		}

		for (const attempt of run.attempts) {
			if (attempt.invalidReason === null) {
				continue;
			}

			const cause = attemptCauseOf(attempt.invalidReason);

			invalidAttemptsByCause[cause] = (invalidAttemptsByCause[cause] ?? 0) + 1;
		}
	}

	return {
		planned,
		stored,
		valid,
		invalid: failures.filter((failure) => failure.cause !== 'missing-execution').length,
		missing: failures.filter((failure) => failure.cause === 'missing-execution').length,
		byCause,
		attempts,
		retriedExecutions,
		invalidAttemptsByCause,
	};
};

const sampleSizeOf = (
	input: Readonly<{
		contract: EconomicContractType;
		caseIds: readonly string[];
		repetitionsPerCase: number;
		seed: string;
		variance: AaVarianceType;
		pairedSuccessDifferences: readonly number[];
	}>,
): AaCalibrationType['sampleSize'] => {
	const {contract, variance} = input;
	const correctness = correctnessSampleSizeOf(input.pairedSuccessDifferences, contract.correctness.nonInferiorityMargin, input.caseIds.length);
	const varianceAvailable =
		variance.withinCaseVariance !== null && variance.betweenCaseVariance !== null && variance.effectLogRatio !== null && input.repetitionsPerCase >= 2;
	// The frozen target is the smallest effect worth claiming. A power design
	// needs a true effect below it; otherwise the point-target condition succeeds
	// only half the time even with infinite repetitions. The design alternative is
	// five percentage points below the target, tied to the same 10% economic effect.
	const designEffectRatio = contract.cost.targetRatio - 0.05;
	const finalCaseCount = contract.suite.caseCount;
	const simulationMaxRepetitions = Math.max(contract.sampleSize.maxRepetitions, 100);
	const cost = finalSampleSizeFromVarianceOf({
		campaignIds: [input.seed],
		finalCampaignId: `${input.seed}:final`,
		caseCount: finalCaseCount,
		pilotRepetitions: input.repetitionsPerCase,
		effectLogRatio: variance.effectLogRatio ?? 0,
		betweenCaseVariance: variance.betweenCaseVarianceCorrected ?? 0,
		withinCaseVariance: variance.withinCaseVariance ?? 0,
		assumedEffectLogRatio: Math.log(designEffectRatio),
		desiredPower: contract.sampleSize.desiredPower,
		oneSidedAlpha: contract.sampleSize.oneSidedAlpha,
		simulations: contract.sampleSize.simulations,
		minRepetitions: contract.sampleSize.minRepetitions,
		maxRepetitions: simulationMaxRepetitions,
		seed: `${input.seed}:aa-sample-size`,
	});
	const chosenRepetitions =
		!varianceAvailable || cost.repetitions === null || correctness.repetitions === null ? null : Math.max(cost.repetitions, correctness.repetitions);
	const executions = chosenRepetitions === null ? null : contract.budget.caseCount * contract.budget.treatments * chosenRepetitions;

	return {
		designEffectRatio,
		assumedEffectLogRatio: Math.log(designEffectRatio),
		finalCaseCount,
		contractMaxRepetitions: contract.sampleSize.maxRepetitions,
		simulationMaxRepetitions,
		cost,
		correctness,
		chosenRepetitions,
		executions,
		withinFrozenExecutionBudget: executions === null ? null : executions <= contract.budget.executions,
		clustering: {
			cases: finalCaseCount,
			repetitionsPerCase: input.repetitionsPerCase,
			intraclassCorrelation: variance.intraclassCorrelation,
			designEffect: variance.designEffect,
		},
		reason: !varianceAvailable
			? 'A/A calibration needs at least two positive-cost pairs per case to estimate within-case variance'
			: (cost.reason ?? correctness.reason),
	};
};

/**
 * Measures natural paired variance and label invariance from two identical arms.
 *
 * Missing, invalid, contaminated, or incompletely metered executions are
 * retained with a closed cause. They are never removed to produce a favorable
 * interval. The sample-size simulation uses the observed variance with the frozen
 * target effect because an A/A arm has no efficacy effect to estimate.
 *
 * @param input - Stored runs, planned pairs, frozen contract, and campaign seed.
 * @returns The sanitized A/A record.
 */
export const aaCalibrationOf = (input: AaCalibrationInputType): AaCalibrationType => {
	const contract = input.contract ?? EVALUATION_CONTRACT;
	const caseIds = input.cases.map((testCase) => testCase.id);
	const {pairs, failures: missingFailures} = pairCandidatesOf(input);
	const failures = [...missingFailures, ...invalidFailuresOf(pairs)];
	const relabeled = relabeledOf(pairs);
	const weights = aaWeightsOf(contract, caseIds);
	const cost = fixedSuiteCostStudyOf(relabeled, {
		weights,
		targetRatio: contract.cost.targetRatio,
		confidence: contract.cost.confidence,
		resamples: contract.confidence.resamples,
		seed: `${input.seed}:aa-cost`,
	});
	const correctness = pairedCorrectnessStudyOf(relabeled, {
		weights,
		margin: contract.correctness.nonInferiorityMargin,
		confidence: contract.correctness.confidence,
		resamples: contract.confidence.resamples,
		seed: `${input.seed}:aa-correctness`,
	});
	const variance = varianceOf(pairs);
	const pairedSuccessDifferences = pairedSuccessDifferencesOf(relabeled, caseIds);
	const equivalence = equivalenceOf(cost, failures);
	const sampleSize = sampleSizeOf({contract, caseIds, repetitionsPerCase: input.repetitionsPerCase, seed: input.seed, variance, pairedSuccessDifferences});
	const validPairs = pairs.filter(
		(pair) => pair.armA.valid && pair.armB.valid && pair.armA.providerCost?.state === 'exact' && pair.armB.providerCost?.state === 'exact',
	);
	const definitionHashes = [...new Set(input.runs.map((run) => run.treatmentDefinitionHash))].sort();
	const surfaceDigests = [...new Set(input.runs.map((run) => run.surface.digest))].sort();
	const planned = input.cases.length * input.repetitionsPerCase * 2;

	return {
		recordType: 'aa-calibration',
		schemaVersion: 1,
		claimClass: 'validity-only',
		efficacyClaim: false,
		releaseAuthority: false,
		seed: input.seed,
		caseIds,
		repetitionsPerCase: input.repetitionsPerCase,
		plannedSlots: planned,
		storedSlots: input.runs.length,
		pairCount: pairs.length,
		validPairs: validPairs.length,
		failures,
		variance: {
			withinCaseVariance: variance.withinCaseVariance,
			betweenCaseVariance: variance.betweenCaseVariance,
			betweenCaseVarianceCorrected: variance.betweenCaseVarianceCorrected,
			effectLogRatio: variance.effectLogRatio,
			intraclassCorrelation: variance.intraclassCorrelation,
			designEffect: variance.designEffect,
			observations: variance.observations,
		},
		labelEffect: {
			equivalence,
			cost,
			correctness,
			correctnessDifference: pairedSuccessDifferences.length === 0 ? null : meanOf(pairedSuccessDifferences),
		},
		diagnostics: {
			a: diagnosticsOf(
				'a',
				pairs.map((pair) => pair.armA),
			),
			b: diagnosticsOf(
				'b',
				pairs.map((pair) => pair.armB),
			),
		},
		failureRate: failureSummaryOf({failures, planned, stored: input.runs.length, valid: validPairs.length * 2, runs: input.runs}),
		treatmentLabelInvariance: {definitionHashes, surfaceDigests, identical: definitionHashes.length === 1 && surfaceDigests.length === 1},
		sampleSize,
		passed:
			equivalence.passed && failures.length === 0 && sampleSize.chosenRepetitions !== null && definitionHashes.length === 1 && surfaceDigests.length === 1,
	};
};
