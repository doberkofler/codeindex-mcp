import {rngOf} from './bootstrapRng.ts';
import {type CostStudyType, type EconomicExecutionType, fixedSuiteCostStudyOf, meanOf, percentileOf, type PairedCaseType, weightedMeanOf} from './costStudy.ts';
import {contractDigestOf, EVALUATION_CONTRACT, type ContractPinType, type EconomicContractType} from './economicContract.ts';
import {ratioOf, type RatioType} from './ratio.ts';

/** Paired non-inferiority result for candidate correctness against no-index. */
export type CorrectnessStudyType = Readonly<{
	state: 'exact' | 'unavailable';
	pairedDifference: number | null;
	oneSidedUpper95: number | null;
	margin: number;
	falseAbsenceCount: number;
	candidateSuccessRate: number | null;
	baselineSuccessRate: number | null;
	gate: Readonly<{passed: boolean; detail: string}>;
	reason: string | null;
}>;

const caseSuccessRateOf = (executions: readonly EconomicExecutionType[], caseId: string, treatment: string): number | null => {
	const values = executions.filter((execution) => execution.valid && execution.caseId === caseId && execution.treatment === treatment);

	return values.length === 0 ? null : values.filter((execution) => execution.correct).length / values.length;
};

/**
 * Estimates paired candidate/no-index correctness non-inferiority.
 *
 * The difference is candidate degradation, `baseline - candidate`. Positive
 * values mean the candidate is worse. The one-sided upper confidence bound must
 * stay below the non-inferiority margin. A timed-out or incorrect execution
 * contributes a zero success and is never dropped. False absence has a strict
 * zero-tolerance rule.
 *
 * @param executions - Economic observations for one campaign.
 * @param options - Frozen weights, margin, confidence, and seed.
 * @returns The paired difference, one-sided bound, and gate.
 */
export const pairedCorrectnessStudyOf = (
	executions: readonly EconomicExecutionType[],
	options: Readonly<{weights: Readonly<Record<string, number>>; margin: number; confidence: 0.95; resamples: number; seed: string}>,
): CorrectnessStudyType => {
	const valid = executions.filter((execution) => execution.valid);
	const caseIds = Object.keys(options.weights);
	const differences: PairedCaseType[] = [];

	for (const caseId of caseIds) {
		const baseline = caseSuccessRateOf(valid, caseId, 'no-index');
		const treatment = caseSuccessRateOf(valid, caseId, 'candidate');

		if (baseline === null || treatment === null) {
			return {
				state: 'unavailable',
				pairedDifference: null,
				oneSidedUpper95: null,
				margin: options.margin,
				falseAbsenceCount: valid.filter((execution) => execution.treatment === 'candidate' && execution.falseAbsence).length,
				candidateSuccessRate: null,
				baselineSuccessRate: null,
				gate: {passed: false, detail: `missing paired correctness arm for ${caseId}`},
				reason: `missing paired correctness arm for ${caseId}`,
			};
		}

		differences.push({caseId, baseline, treatment});
	}

	if (differences.length === 0) {
		return {
			state: 'unavailable',
			pairedDifference: null,
			oneSidedUpper95: null,
			margin: options.margin,
			falseAbsenceCount: 0,
			candidateSuccessRate: null,
			baselineSuccessRate: null,
			gate: {passed: false, detail: 'no paired correctness cases'},
			reason: 'no paired correctness cases',
		};
	}

	const point = weightedMeanOf(differences, options.weights, 'baseline') - weightedMeanOf(differences, options.weights, 'treatment');
	const random = rngOf(options.seed);
	const draws: number[] = [];

	for (let resample = 0; resample < options.resamples; resample += 1) {
		const drawn = Array.from({length: differences.length}, () => differences[Math.floor(random() * differences.length)]).filter(
			(pair): pair is PairedCaseType => pair !== undefined,
		);
		draws.push(weightedMeanOf(drawn, options.weights, 'baseline') - weightedMeanOf(drawn, options.weights, 'treatment'));
	}

	const upper = percentileOf(draws, options.confidence);
	const falseAbsenceCount = valid.filter((execution) => execution.treatment === 'candidate' && execution.falseAbsence).length;
	const candidateSuccess = valid.filter((execution) => execution.treatment === 'candidate');
	const baselineSuccess = valid.filter((execution) => execution.treatment === 'no-index');
	const passed = upper < options.margin && falseAbsenceCount === 0;

	return {
		state: 'exact',
		pairedDifference: point,
		oneSidedUpper95: upper,
		margin: options.margin,
		falseAbsenceCount,
		candidateSuccessRate: candidateSuccess.length === 0 ? null : candidateSuccess.filter((execution) => execution.correct).length / candidateSuccess.length,
		baselineSuccessRate: baselineSuccess.length === 0 ? null : baselineSuccess.filter((execution) => execution.correct).length / baselineSuccess.length,
		gate: {
			passed,
			detail: `paired difference ${point.toFixed(4)}; one-sided upper ${upper.toFixed(4)}; margin ${options.margin.toFixed(2)}; false absence ${falseAbsenceCount}`,
		},
		reason: null,
	};
};

/** Latency recorded against the frozen timeout ceiling; never an optimization target. */
export type LatencyStudyType = Readonly<{
	executionCount: number;
	timedOutCount: number;
	maxDurationMs: number;
	timeoutCeilingMs: number;
	ceilingSatisfied: boolean;
	optimizationTarget: false;
}>;

/**
 * Records latency and timeout behavior without turning either into a target.
 *
 * @param executions - Economic observations for one campaign.
 * @param timeoutCeilingMs - Frozen per-execution ceiling.
 * @returns Descriptive latency facts.
 */
export const latencyStudyOf = (executions: readonly EconomicExecutionType[], timeoutCeilingMs: number): LatencyStudyType => {
	const valid = executions.filter((execution) => execution.valid);

	return {
		executionCount: valid.length,
		timedOutCount: valid.filter((execution) => execution.timedOut).length,
		maxDurationMs: valid.length === 0 ? 0 : Math.max(...valid.map((execution) => execution.durationMs)),
		timeoutCeilingMs,
		ceilingSatisfied: valid.every((execution) => execution.timeoutMs <= timeoutCeilingMs),
		optimizationTarget: false,
	};
};

/** Complete contract-scoped analysis appended to a paired report. */
export type EconomicAnalysisType = Readonly<{
	contract: ContractPinType;
	estimand: EconomicContractType['estimand'];
	weights: Readonly<Record<string, number>>;
	executions: Readonly<{
		valid: number;
		correct: number;
		incorrectIncluded: number;
		falseAbsence: number;
		timedOut: number;
		costExact: number;
		costUnavailable: number;
	}>;
	cost: CostStudyType;
	correctness: CorrectnessStudyType;
	latency: LatencyStudyType;
	output: Readonly<{
		metric: 'all-tool-output-bytes';
		families: readonly string[];
		candidatePreweightedMeanBytes: number | null;
		baselinePreweightedMeanBytes: number | null;
		ratio: RatioType;
	}>;
	thresholds: readonly Readonly<{name: string; passed: boolean; detail: string}>[];
	passed: boolean;
}>;

const outputSummaryOf = (executions: readonly EconomicExecutionType[], weights: Readonly<Record<string, number>>): EconomicAnalysisType['output'] => {
	const valid = executions.filter((execution) => execution.valid);

	const preweightedMeanOf = (treatment: string): number | null => {
		const pairs: PairedCaseType[] = Object.keys(weights).flatMap((caseId) => {
			const values = valid
				.filter((execution) => execution.caseId === caseId && execution.treatment === treatment)
				.map((execution) => execution.allToolOutputBytes);
			const value = meanOf(values);

			return values.length === 0 ? [] : [{caseId, baseline: value, treatment: value}];
		});
		const weightSum = pairs.reduce((total, pair) => total + (weights[pair.caseId] ?? 0), 0);

		return weightSum === 0 ? null : pairs.reduce((total, pair) => total + (weights[pair.caseId] ?? 0) * pair.treatment, 0) / weightSum;
	};

	const baseline = preweightedMeanOf('no-index');
	const candidate = preweightedMeanOf('candidate');

	return {
		metric: 'all-tool-output-bytes',
		families: EVALUATION_CONTRACT.output.families,
		candidatePreweightedMeanBytes: candidate,
		baselinePreweightedMeanBytes: baseline,
		ratio: baseline === null || candidate === null ? {state: 'finite', value: null} : ratioOf(candidate, baseline),
	};
};

/**
 * Evaluates one campaign under the accepted contract.
 *
 * @param executions - All executions, including incorrect but valid ones.
 * @param contract - Frozen contract.
 * @param seed - Deterministic interval seed.
 * @returns Economic, correctness, latency, output, and threshold evidence.
 */
export const economicAnalysisOf = (executions: readonly EconomicExecutionType[], contract: EconomicContractType, seed: string): EconomicAnalysisType => {
	const valid = executions.filter((execution) => execution.valid);
	const weights = contract.suite.caseWeights;
	const cost = fixedSuiteCostStudyOf(executions, {
		weights,
		targetRatio: contract.cost.targetRatio,
		confidence: contract.cost.confidence,
		resamples: contract.confidence.resamples,
		seed: `${seed}:cost`,
	});
	const correctness = pairedCorrectnessStudyOf(executions, {
		weights,
		margin: contract.correctness.nonInferiorityMargin,
		confidence: contract.correctness.confidence,
		resamples: contract.confidence.resamples,
		seed: `${seed}:correctness`,
	});
	const latency = latencyStudyOf(executions, contract.latency.timeoutCeilingMs);
	const output = outputSummaryOf(executions, weights);
	const thresholds = [
		{
			name: `preweighted candidate/no-index total task cost ratio <= ${contract.cost.targetRatio.toFixed(2)} with one-sided 95% upper bound < ${contract.cost.upperBoundBelow.toFixed(2)}`,
			passed: cost.gate.passed,
			detail: cost.gate.detail,
		},
		{
			name: `paired correctness non-inferiority upper bound < ${contract.correctness.nonInferiorityMargin.toFixed(2)}`,
			passed: correctness.gate.passed,
			detail: correctness.gate.detail,
		},
		{
			name: 'false absence has zero tolerance',
			passed: correctness.falseAbsenceCount === 0,
			detail: `${correctness.falseAbsenceCount} candidate false absence(s)`,
		},
		{
			name: `latency recorded under the ${contract.latency.timeoutCeilingMs} ms timeout ceiling and not optimized`,
			passed: latency.ceilingSatisfied,
			detail: `${latency.timedOutCount} timeout(s); max ${latency.maxDurationMs} ms; target=${String(latency.optimizationTarget)}`,
		},
		{
			name: 'every valid execution has an exact provider request vector',
			passed: cost.state === 'exact',
			detail: `${valid.filter((execution) => execution.costUsd !== null).length}/${valid.length} valid execution(s) exact`,
		},
		{
			name: 'every tool-output family is included in the output metric',
			passed: output.families.join(',') === contract.output.families.join(','),
			detail: output.families.join(', '),
		},
	];

	return {
		contract: {id: contract.id, version: contract.version, digest: contractDigestOf(contract), frozenAt: contract.frozenAt},
		estimand: contract.estimand,
		weights,
		executions: {
			valid: valid.length,
			correct: valid.filter((execution) => execution.correct).length,
			incorrectIncluded: valid.filter((execution) => !execution.correct).length,
			falseAbsence: valid.filter((execution) => execution.falseAbsence).length,
			timedOut: valid.filter((execution) => execution.timedOut).length,
			costExact: valid.filter((execution) => execution.costUsd !== null).length,
			costUnavailable: valid.filter((execution) => execution.costUsd === null).length,
		},
		cost,
		correctness,
		latency,
		output,
		thresholds,
		passed: thresholds.every((threshold) => threshold.passed),
	};
};
