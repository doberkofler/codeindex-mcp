import {rngOf} from './bootstrapRng.ts';
import {ratioOf, type RatioType} from './ratio.ts';
import {type RunResultType} from './runTypes.ts';

/** One valid-or-invalid execution projected onto the economic contract. */
export type EconomicExecutionType = Readonly<{
	caseId: string;
	caseClass: string;
	treatment: string;
	repetition: number;
	valid: boolean;
	correct: boolean;
	falseAbsence: boolean;
	timedOut: boolean;
	durationMs: number;
	timeoutMs: number;
	/** Exact total user-visible task cost, or null when no complete vector exists. */
	costUsd: number | null;
	costState: 'exact' | 'unavailable' | 'not-applicable';
	/** Every tool-output family, including shell/execute and task output. */
	allToolOutputBytes: number;
	toolOutputByFamily: Readonly<Record<string, number>>;
}>;

const isEvidenceRunOf = (run: RunResultType): boolean => run.valid && run.defects.length === 0 && run.outcome !== 'aborted';

const familyOutputBytesOf = (run: RunResultType): number => Object.values(run.familyBytes).reduce((total, value) => total + value, 0);

/**
 * Projects stored results onto the economic contract without dropping valid
 * incorrect executions.
 *
 * @param runs - Stored results in one campaign.
 * @returns One economic observation per execution.
 */
export const economicExecutionsOf = (runs: readonly RunResultType[]): readonly EconomicExecutionType[] =>
	runs.map((run) => ({
		caseId: run.caseId,
		caseClass: run.caseClass,
		treatment: run.treatment,
		repetition: run.repetition,
		valid: isEvidenceRunOf(run),
		correct: run.grade.success,
		falseAbsence: run.grade.falseAbsence,
		timedOut: run.timedOut,
		durationMs: run.durationMs,
		timeoutMs: run.timeoutMs,
		costUsd: run.providerCost?.state === 'exact' ? run.providerCost.totalUsd : null,
		costState: run.providerCost?.state ?? 'unavailable',
		allToolOutputBytes: familyOutputBytesOf(run),
		toolOutputByFamily: run.familyBytes,
	}));

export const isFiniteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

export const meanOf = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length);

export const percentileOf = (values: readonly number[], fraction: number): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const rank = Math.ceil(fraction * sorted.length) - 1;

	return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
};

/** One paired case with exact arm values. */
export type PairedCaseType = Readonly<{
	caseId: string;
	baseline: number;
	treatment: number;
}>;

/** One preweighted fixed-suite cost estimate and its intervals. */
export type CostStudyType = Readonly<{
	state: 'exact' | 'unavailable';
	metric: 'total-user-visible-task-cost-usd';
	population: 'fixed-suite';
	baseline: 'no-index';
	treatment: 'candidate';
	caseCount: number;
	executionCount: number;
	incorrectExecutionCount: number;
	baselineMeanUsd: number | null;
	treatmentMeanUsd: number | null;
	ratio: RatioType;
	targetRatio: number;
	oneSidedUpper95: number | null;
	oneSidedUpperState: 'bounded' | 'unbounded' | 'unavailable';
	twoSidedInterval95: Readonly<{low: number; high: number; confidence: 0.95}> | null;
	caseGeneralization: Readonly<{
		meanRatio: RatioType;
		oneSidedUpper95: number | null;
		oneSidedUpperState: 'bounded' | 'unbounded' | 'unavailable';
		method: 'paired-case-uniform-bootstrap';
	}>;
	gate: Readonly<{passed: boolean; detail: string}>;
	reason: string | null;
	pairs: readonly PairedCaseType[];
}>;

const pairedCostCasesOf = (
	executions: readonly EconomicExecutionType[],
	weights: Readonly<Record<string, number>>,
): Readonly<{pairs: readonly PairedCaseType[]; executionCount: number; incorrectExecutionCount: number; reason: string | null}> => {
	const valid = executions.filter((execution) => execution.valid);
	const caseIds = Object.keys(weights);

	if (caseIds.length === 0) {
		return {pairs: [], executionCount: 0, incorrectExecutionCount: 0, reason: 'contract has no case weights'};
	}

	const missing = caseIds.filter(
		(caseId) =>
			!valid.some((execution) => execution.caseId === caseId && execution.treatment === 'no-index') ||
			!valid.some((execution) => execution.caseId === caseId && execution.treatment === 'candidate'),
	);

	if (missing.length > 0) {
		return {
			pairs: [],
			executionCount: valid.length,
			incorrectExecutionCount: valid.filter((execution) => !execution.correct).length,
			reason: `missing paired arm for ${missing.join(', ')}`,
		};
	}

	const missingCost = valid.filter((execution) => (execution.treatment === 'no-index' || execution.treatment === 'candidate') && execution.costUsd === null);

	if (missingCost.length > 0) {
		return {
			pairs: [],
			executionCount: valid.length,
			incorrectExecutionCount: valid.filter((execution) => !execution.correct).length,
			reason: `${missingCost.length} valid execution(s) have no exact total task cost`,
		};
	}

	const pairs = caseIds.map((caseId) => {
		const baseline = valid.filter((execution) => execution.caseId === caseId && execution.treatment === 'no-index').map((execution) => execution.costUsd ?? 0);
		const treatment = valid
			.filter((execution) => execution.caseId === caseId && execution.treatment === 'candidate')
			.map((execution) => execution.costUsd ?? 0);

		return {caseId, baseline: meanOf(baseline), treatment: meanOf(treatment)};
	});

	return {pairs, executionCount: valid.length, incorrectExecutionCount: valid.filter((execution) => !execution.correct).length, reason: null};
};

export const weightedMeanOf = (pairs: readonly PairedCaseType[], weights: Readonly<Record<string, number>>, arm: 'baseline' | 'treatment'): number => {
	const weightSum = pairs.reduce((total, pair) => total + (weights[pair.caseId] ?? 0), 0);

	return pairs.reduce((total, pair) => total + (weights[pair.caseId] ?? 0) * pair[arm], 0) / weightSum;
};

const weightedRatioOf = (pairs: readonly PairedCaseType[], weights: Readonly<Record<string, number>>): RatioType =>
	ratioOf(weightedMeanOf(pairs, weights, 'treatment'), weightedMeanOf(pairs, weights, 'baseline'));

const bootstrapCostDrawsOf = (
	pairs: readonly PairedCaseType[],
	weights: Readonly<Record<string, number>>,
	options: Readonly<{resamples: number; seed: string; uniform: boolean}>,
): Readonly<{values: readonly number[]; unbounded: boolean}> => {
	const random = rngOf(options.seed);
	const values: number[] = [];
	let unbounded = false;

	for (let resample = 0; resample < options.resamples; resample += 1) {
		const drawn = Array.from({length: pairs.length}, () => pairs[Math.floor(random() * pairs.length)]).filter(
			(pair): pair is PairedCaseType => pair !== undefined,
		);
		const drawWeights = options.uniform ? Object.fromEntries(drawn.map((pair) => [pair.caseId, 1])) : weights;
		const ratio = weightedRatioOf(drawn, drawWeights);

		if (ratio.state === 'positive-over-zero') {
			unbounded = true;
		} else if (ratio.value !== null) {
			values.push(ratio.value);
		}
	}

	return {values, unbounded};
};

/** Closed input for an unavailable fixed-suite cost study. */
type UnavailableCostStudyInputType = Readonly<{
	pairs: readonly PairedCaseType[];
	executionCount: number;
	incorrectExecutionCount: number;
	targetRatio: number;
	reason: string | null;
}>;

/**
 * Builds the closed unavailable result of one cost study.
 *
 * @param input - Paired cases, execution counts, target, and reason.
 * @returns An unavailable cost study.
 */
const unavailableCostStudyOf = (input: UnavailableCostStudyInputType): CostStudyType => {
	const {pairs, executionCount, incorrectExecutionCount, targetRatio, reason} = input;

	return {
		state: 'unavailable',
		metric: 'total-user-visible-task-cost-usd',
		population: 'fixed-suite',
		baseline: 'no-index',
		treatment: 'candidate',
		caseCount: pairs.length,
		executionCount,
		incorrectExecutionCount,
		baselineMeanUsd: null,
		treatmentMeanUsd: null,
		ratio: {state: 'finite', value: null},
		targetRatio,
		oneSidedUpper95: null,
		oneSidedUpperState: 'unavailable',
		twoSidedInterval95: null,
		caseGeneralization: {
			meanRatio: {state: 'finite', value: null},
			oneSidedUpper95: null,
			oneSidedUpperState: 'unavailable',
			method: 'paired-case-uniform-bootstrap',
		},
		gate: {passed: false, detail: reason ?? 'cost estimate unavailable'},
		reason,
		pairs,
	};
};

const intervalStateOf = (unbounded: boolean, upper: number | null): CostStudyType['oneSidedUpperState'] =>
	unbounded ? 'unbounded' : upper === null ? 'unavailable' : 'bounded';

const costGateOf = (point: RatioType, upper: number | null, targetRatio: number): Readonly<{passed: boolean; detail: string}> => ({
	passed: point.state === 'finite' && point.value !== null && point.value <= targetRatio && upper !== null && upper < 1,
	detail:
		point.value === null
			? `candidate/no-index ratio is ${point.state}`
			: `${point.value.toFixed(3)} candidate/no-index; one-sided upper ${upper === null ? 'unbounded' : upper.toFixed(3)} (target <= ${targetRatio.toFixed(2)}, upper < 1.00)`,
});

/**
 * Estimates the preweighted fixed-suite cost ratio over paired cases.
 *
 * Every valid execution participates regardless of answer correctness. The
 * one-sided interval resamples whole cases with their frozen weights; the
 * case-generalization interval uses the same draws with uniform case weights and
 * remains descriptive.
 *
 * @param executions - Economic observations for one campaign.
 * @param options - Frozen weights, target, confidence, and deterministic seed.
 * @returns The fixed-suite estimate, intervals, and gate.
 */
export const fixedSuiteCostStudyOf = (
	executions: readonly EconomicExecutionType[],
	options: Readonly<{
		weights: Readonly<Record<string, number>>;
		targetRatio: number;
		confidence: 0.95;
		resamples: number;
		seed: string;
	}>,
): CostStudyType => {
	const {pairs, executionCount, incorrectExecutionCount, reason} = pairedCostCasesOf(executions, options.weights);

	if (pairs.length === 0 || reason !== null) {
		return unavailableCostStudyOf({pairs, executionCount, incorrectExecutionCount, targetRatio: options.targetRatio, reason});
	}

	const point = weightedRatioOf(pairs, options.weights);
	const baselineMean = weightedMeanOf(pairs, options.weights, 'baseline');
	const treatmentMean = weightedMeanOf(pairs, options.weights, 'treatment');

	if (!isFiniteNonNegative(baselineMean) || !isFiniteNonNegative(treatmentMean)) {
		return {
			...unavailableCostStudyOf({pairs, executionCount, incorrectExecutionCount, targetRatio: options.targetRatio, reason: null}),
			reason: 'a preweighted cost mean is not a finite non-negative value',
		};
	}

	const fixed = bootstrapCostDrawsOf(pairs, options.weights, {resamples: options.resamples, seed: options.seed, uniform: false});
	const generalization = bootstrapCostDrawsOf(pairs, options.weights, {resamples: options.resamples, seed: `${options.seed}:case`, uniform: true});
	const upper = fixed.unbounded || fixed.values.length === 0 ? null : percentileOf(fixed.values, options.confidence);
	const low = fixed.values.length === 0 ? null : percentileOf(fixed.values, (1 - options.confidence) / 2);
	const high = fixed.values.length === 0 ? null : percentileOf(fixed.values, (1 + options.confidence) / 2);
	const generalizationUpper = generalization.unbounded || generalization.values.length === 0 ? null : percentileOf(generalization.values, options.confidence);

	return {
		state: 'exact',
		metric: 'total-user-visible-task-cost-usd',
		population: 'fixed-suite',
		baseline: 'no-index',
		treatment: 'candidate',
		caseCount: pairs.length,
		executionCount,
		incorrectExecutionCount,
		baselineMeanUsd: baselineMean,
		treatmentMeanUsd: treatmentMean,
		ratio: point,
		targetRatio: options.targetRatio,
		oneSidedUpper95: upper,
		oneSidedUpperState: intervalStateOf(fixed.unbounded, upper),
		twoSidedInterval95: low === null || high === null ? null : {low, high, confidence: options.confidence},
		caseGeneralization: {
			meanRatio: weightedRatioOf(pairs, Object.fromEntries(pairs.map((pair) => [pair.caseId, 1]))),
			oneSidedUpper95: generalizationUpper,
			oneSidedUpperState: intervalStateOf(generalization.unbounded, generalizationUpper),
			method: 'paired-case-uniform-bootstrap',
		},
		gate: costGateOf(point, upper, options.targetRatio),
		reason: null,
		pairs,
	};
};
