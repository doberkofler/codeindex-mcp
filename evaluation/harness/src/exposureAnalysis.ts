import {rngOf} from './bootstrapRng.ts';
import {EVALUATION_CONTRACT} from './economicContract.ts';
import {type ExposureCoreQueryType} from './exposureCore.ts';
import {type ExposureDesignType} from './exposureDesign.ts';
import {type ExposurePlanType} from './exposurePlan.ts';
import {hashOf} from './hash.ts';
import {ratioOf} from './ratio.ts';
import {surfaceRequestLedgerOf, type SurfaceRequestLedgerType} from './requestSurface.ts';
import {type RunResultType} from './runTypes.ts';
import {
	EXPOSURE_METRICS,
	type ExposureCorrectnessType,
	type ExposureDecisionActionType,
	type ExposureMetricComparisonType,
	type ExposureMetricNameType,
	type ExposureRecommendationType,
	type ExposureReliabilityType,
	type ExposureReportType,
	type ExposureSurfaceType,
	type ExposureTrajectoryType,
} from './exposureTypes.ts';

type CaseMetricPairType = Readonly<{
	caseId: string;
	direct: readonly number[];
	codeMode: readonly number[];
}>;

const evidenceRunOf = (run: RunResultType): boolean => run.valid && run.defects.length === 0 && run.outcome !== 'aborted';

const exactMeteringOf = (run: RunResultType): boolean => {
	const reconciliation = run.providerMeter;

	if (run.providerCost?.state !== 'exact' || reconciliation === null || reconciliation === undefined) {
		return false;
	}

	return reconciliation.economicClaim.state === 'exact' && reconciliation.settledExactlyOnce && reconciliation.requestCount > 0;
};

const requestOneOf = (run: RunResultType): SurfaceRequestLedgerType => {
	const requests = (run.providerMeter?.requests ?? []).map((request) => ({
		ordinal: request.ordinal,
		kind: request.kind,
		toolNames: request.toolNames,
	}));

	return surfaceRequestLedgerOf(run.surface, requests);
};

const requestBytesOf = (run: RunResultType): number => (run.providerMeter?.requests ?? []).reduce((total, request) => total + request.requestBytes, 0);

const responseBytesOf = (run: RunResultType): number | null => {
	const requests = run.providerMeter?.requests ?? [];

	if (requests.length === 0 || requests.some((request) => request.responseBytes === null)) {
		return null;
	}

	return requests.reduce((total, request) => total + (request.responseBytes ?? 0), 0);
};

const trajectoryOf = (run: RunResultType, coreByCase: ReadonlyMap<string, number | null>): ExposureTrajectoryType => ({
	caseId: run.caseId,
	treatment: run.treatment,
	repetition: run.repetition,
	valid: evidenceRunOf(run),
	exactMetering: exactMeteringOf(run),
	correct: run.grade.success,
	falseAbsence: run.grade.falseAbsence,
	requestOne: requestOneOf(run),
	requestCount: run.providerMeter?.requestCount ?? 0,
	requestBytes: requestBytesOf(run),
	responseBytes: responseBytesOf(run),
	toolCalls: run.toolCalls.length,
	executeCalls: run.routing.executeCalls,
	codeIndexCalls: run.routing.codeIndexCalls,
	wallTimeMs: run.durationMs,
	coreQueryMs: coreByCase.get(run.caseId) ?? null,
	totalTaskCostUsd: run.providerCost?.state === 'exact' ? run.providerCost.totalUsd : null,
	pathClean: run.providerMeter?.pathClean ?? true,
	timedOut: run.timedOut,
	attemptCount: run.attempts.length,
	toolSequence: run.toolCalls.map((call) => call.tool),
});

const metricValueOf = (trajectory: ExposureTrajectoryType, metric: ExposureMetricNameType): number | null => {
	if (!trajectory.valid || !trajectory.exactMetering) {
		return null;
	}

	if (metric === 'totalTaskCostUsd') {
		return trajectory.totalTaskCostUsd;
	}

	if (metric === 'requestBytes') {
		return trajectory.requestBytes;
	}

	if (metric === 'responseBytes') {
		return trajectory.responseBytes;
	}

	if (metric === 'toolCalls') {
		return trajectory.toolCalls;
	}

	if (metric === 'wallTimeMs') {
		return trajectory.wallTimeMs;
	}

	return trajectory.coreQueryMs;
};

const meanOf = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length);

const percentileOf = (values: readonly number[], fraction: number): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const rank = Math.ceil(fraction * sorted.length) - 1;

	return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
};

const pairsOf = (trajectories: readonly ExposureTrajectoryType[], metric: ExposureMetricNameType): readonly CaseMetricPairType[] => {
	const caseIds = [...new Set(trajectories.map((trajectory) => trajectory.caseId))].sort();

	return caseIds.flatMap((caseId) => {
		const valuesOf = (treatment: string): readonly number[] =>
			trajectories
				.filter((trajectory) => trajectory.caseId === caseId && trajectory.treatment === treatment)
				.map((trajectory) => metricValueOf(trajectory, metric))
				.filter((value): value is number => value !== null);
		const direct = valuesOf('direct-mcp');
		const codeMode = valuesOf('code-mode');

		return direct.length === 0 || codeMode.length === 0 ? [] : [{caseId, direct, codeMode}];
	});
};

const pairMeansOf = (pairs: readonly CaseMetricPairType[]): readonly Readonly<{caseId: string; direct: number; codeMode: number}>[] =>
	pairs.map((pair) => ({caseId: pair.caseId, direct: meanOf(pair.direct), codeMode: meanOf(pair.codeMode)}));

const metricUnitOf = (metric: ExposureMetricNameType): ExposureMetricComparisonType['unit'] =>
	metric === 'totalTaskCostUsd' ? 'usd' : metric === 'requestBytes' || metric === 'responseBytes' ? 'bytes' : metric === 'toolCalls' ? 'calls' : 'ms';

const metricComparisonOf = (trajectories: readonly ExposureTrajectoryType[], metric: ExposureMetricNameType, seed: string): ExposureMetricComparisonType => {
	const pairs = pairsOf(trajectories, metric);
	const unit = metricUnitOf(metric);

	if (pairs.length === 0) {
		return {
			metric,
			unit,
			pairCount: 0,
			directMean: null,
			codeModeMean: null,
			delta: null,
			ratio: {state: 'finite', value: null},
			deltaInterval95: null,
			ratioInterval95: null,
			oneSidedUpper95: null,
			oneSidedUpperState: 'unavailable',
			state: 'unavailable',
			reason: 'no valid pair carries this exact metric',
		};
	}

	const means = pairMeansOf(pairs);
	const directMean = meanOf(means.map((pair) => pair.direct));
	const codeModeMean = meanOf(means.map((pair) => pair.codeMode));
	const ratio = ratioOf(codeModeMean, directMean);
	const random = rngOf(hashOf({seed, purpose: 'exposure-metric', metric}));
	const deltas: number[] = [];
	const ratios: number[] = [];
	let unbounded = false;

	for (let resample = 0; resample < EVALUATION_CONTRACT.confidence.resamples; resample += 1) {
		const drawn = Array.from({length: means.length}, () => means[Math.floor(random() * means.length)]).filter(
			(pair): pair is (typeof means)[number] => pair !== undefined,
		);
		const sampledDirect = meanOf(drawn.map((pair) => pair.direct));
		const sampledCodeMode = meanOf(drawn.map((pair) => pair.codeMode));
		const sampledRatio = ratioOf(sampledCodeMode, sampledDirect);

		deltas.push(sampledCodeMode - sampledDirect);

		if (sampledRatio.state === 'positive-over-zero') {
			unbounded = true;
		} else if (sampledRatio.value !== null) {
			ratios.push(sampledRatio.value);
		}
	}

	const exact = means.length === pairs.length && pairs.length === new Set(trajectories.map((trajectory) => trajectory.caseId)).size;

	return {
		metric,
		unit,
		pairCount: pairs.length,
		directMean,
		codeModeMean,
		delta: codeModeMean - directMean,
		ratio,
		deltaInterval95: {low: percentileOf(deltas, 0.025), high: percentileOf(deltas, 0.975), confidence: 0.95},
		ratioInterval95: unbounded ? null : {low: percentileOf(ratios, 0.025), high: percentileOf(ratios, 0.975), confidence: 0.95},
		oneSidedUpper95: unbounded ? null : percentileOf(ratios, EVALUATION_CONTRACT.cost.confidence),
		oneSidedUpperState: unbounded ? 'unbounded' : 'bounded',
		state: exact ? 'exact' : 'unavailable',
		reason: exact ? null : 'one or more valid executions could not be paired',
	};
};

const correctnessOf = (trajectories: readonly ExposureTrajectoryType[], design: ExposureDesignType): ExposureCorrectnessType => {
	const valid = trajectories.filter((trajectory) => trajectory.valid);
	const caseIds = design.cases.map((testCase) => testCase.id);
	const differences: readonly Readonly<{caseId: string; direct: number; codeMode: number}>[] = caseIds.flatMap((caseId) => {
		const rateOf = (treatment: string): number | null => {
			const selected = valid.filter((trajectory) => trajectory.caseId === caseId && trajectory.treatment === treatment);

			return selected.length === 0 ? null : selected.filter((trajectory) => trajectory.correct).length / selected.length;
		};
		const direct = rateOf('direct-mcp');
		const codeMode = rateOf('code-mode');

		return direct === null || codeMode === null ? [] : [{caseId, direct, codeMode}];
	});

	if (differences.length !== caseIds.length) {
		return {
			state: 'unavailable',
			directSuccessRate: null,
			codeModeSuccessRate: null,
			pairedDegradation: null,
			oneSidedUpper95: null,
			margin: design.thresholds.nonInferiorityMargin,
			falseAbsenceCount: valid.filter((trajectory) => trajectory.treatment === 'code-mode' && trajectory.falseAbsence).length,
			gate: {passed: false, detail: 'a fixed case lacks a valid pair'},
			reason: 'a fixed case lacks a valid pair',
		};
	}

	const point = meanOf(differences.map((difference) => difference.direct - difference.codeMode));
	const random = rngOf(hashOf({seed: design.seed, purpose: 'exposure-correctness'}));
	const draws: number[] = [];

	for (let resample = 0; resample < EVALUATION_CONTRACT.confidence.resamples; resample += 1) {
		const drawn = Array.from({length: differences.length}, () => differences[Math.floor(random() * differences.length)]).filter(
			(difference): difference is (typeof differences)[number] => difference !== undefined,
		);

		draws.push(meanOf(drawn.map((difference) => difference.direct - difference.codeMode)));
	}

	const upper = percentileOf(draws, EVALUATION_CONTRACT.correctness.confidence);
	const falseAbsenceCount = valid.filter((trajectory) => trajectory.treatment === 'code-mode' && trajectory.falseAbsence).length;
	const directRate = meanOf(differences.map((difference) => difference.direct));
	const codeModeRate = meanOf(differences.map((difference) => difference.codeMode));
	const passed = upper < design.thresholds.nonInferiorityMargin && falseAbsenceCount === 0;

	return {
		state: 'exact',
		directSuccessRate: directRate,
		codeModeSuccessRate: codeModeRate,
		pairedDegradation: point,
		oneSidedUpper95: upper,
		margin: design.thresholds.nonInferiorityMargin,
		falseAbsenceCount,
		gate: {
			passed,
			detail: `paired degradation ${point.toFixed(4)}; one-sided upper ${upper.toFixed(4)}; margin ${design.thresholds.nonInferiorityMargin.toFixed(2)}; false absence ${falseAbsenceCount}`,
		},
		reason: null,
	};
};

const surfaceOf = (trajectories: readonly ExposureTrajectoryType[], treatment: 'direct-mcp' | 'code-mode'): ExposureSurfaceType => {
	const selected = trajectories.filter((trajectory) => trajectory.treatment === treatment);
	const declared = selected[0]?.requestOne.declared ?? [];

	return {
		treatment,
		declared,
		executions: selected.length,
		exact: selected.filter((trajectory) => trajectory.requestOne.result === 'pass').length,
		failures: selected
			.filter((trajectory) => trajectory.requestOne.result !== 'pass')
			.map((trajectory) => ({
				caseId: trajectory.caseId,
				repetition: trajectory.repetition,
				cause: trajectory.requestOne.cause,
				differences: trajectory.requestOne.differences,
			})),
	};
};

const reliabilityOf = (trajectories: readonly ExposureTrajectoryType[], plannedExecutions: number): ExposureReliabilityType => {
	const valid = trajectories.filter((trajectory) => trajectory.valid);

	return {
		plannedExecutions,
		storedExecutions: trajectories.length,
		validExecutions: valid.length,
		invalidExecutions: trajectories.length - valid.length,
		exactMetering: valid.filter((trajectory) => trajectory.exactMetering).length,
		pathClean: trajectories.every((trajectory) => trajectory.pathClean),
		timedOut: trajectories.filter((trajectory) => trajectory.timedOut).length,
		retriedSlots: trajectories.filter((trajectory) => trajectory.attemptCount > 1).length,
		failedAttempts: trajectories.reduce((total, trajectory) => total + Math.max(0, trajectory.attemptCount - 1), 0),
	};
};

const limitationsOf = (): readonly string[] => [
	'The claim is scoped to the exact hosted model, client runtime, artifact, fixed cases, ordinary tools, tariff, and exposure definitions pinned by the design.',
	'Core query time is the artifact-reported handler duration from the pinned model-free route report; it is measured separately from provider cost and exposure overhead.',
	'This record is post-certification evidence. It does not change, re-grade, or enlarge EVAL-037, and the frozen production exposure stays direct MCP until a reviewer records a new decision.',
	'Provider cost is static-tariff arithmetic over retained provider components, not invoice-time cost.',
	'Code Mode overhead is measured only through the OpenCode client version pinned by the design.',
];

const comparisonCompleteOf = (
	input: Readonly<{
		reliability: ExposureReliabilityType;
		metrics: Readonly<Record<ExposureMetricNameType, ExposureMetricComparisonType>>;
		correctness: ExposureCorrectnessType;
		directSurface: ExposureSurfaceType;
		codeModeSurface: ExposureSurfaceType;
		plannedExecutions: number;
	}>,
): boolean => {
	const {reliability, metrics, correctness, directSurface, codeModeSurface, plannedExecutions} = input;
	const plannedPerArm = plannedExecutions / 2;

	return (
		reliability.storedExecutions === plannedExecutions &&
		reliability.validExecutions === plannedExecutions &&
		reliability.exactMetering === plannedExecutions &&
		reliability.pathClean &&
		correctness.state === 'exact' &&
		EXPOSURE_METRICS.every((metric) => metrics[metric].state === 'exact') &&
		directSurface.exact === plannedPerArm &&
		codeModeSurface.exact === plannedPerArm
	);
};

const decisionOf = (
	input: Readonly<{
		design: ExposureDesignType;
		reliability: ExposureReliabilityType;
		metrics: Readonly<Record<ExposureMetricNameType, ExposureMetricComparisonType>>;
		correctness: ExposureCorrectnessType;
		directSurface: ExposureSurfaceType;
		codeModeSurface: ExposureSurfaceType;
		coreQuery: ExposureCoreQueryType;
		plannedExecutions: number;
	}>,
): Readonly<{recommendation: ExposureRecommendationType; action: ExposureDecisionActionType; reason: string}> => {
	const {design, reliability, metrics, correctness, coreQuery, plannedExecutions} = input;
	const cost = metrics.totalTaskCostUsd;
	const complete = comparisonCompleteOf(input);
	const coreComplete = coreQuery.state === 'exact' && cost.state === 'exact';
	const savingThreshold = 1 - design.thresholds.minimumCostSaving;
	const adopt = complete && coreComplete && cost.oneSidedUpper95 !== null && cost.oneSidedUpper95 < savingThreshold && correctness.gate.passed;

	if (adopt) {
		return {
			recommendation: 'code-mode',
			action: 'reopen-frozen-exposure',
			reason: `Code Mode upper cost ratio ${String(cost.oneSidedUpper95)} is below ${savingThreshold.toFixed(2)} with non-inferior correctness and exact metering`,
		};
	}

	if (complete && coreComplete) {
		return {
			recommendation: 'direct-mcp',
			action: 'retain-frozen-direct',
			reason: `the measured Code Mode saving does not clear the predeclared ${(design.thresholds.minimumCostSaving * 100).toFixed(0)}% threshold${correctness.gate.passed ? '' : ' or correctness is not non-inferior'}`,
		};
	}

	return {
		recommendation: 'inconclusive',
		action: 'blocked',
		reason: `the comparison is incomplete: ${String(reliability.storedExecutions)}/${plannedExecutions} stored, ${String(reliability.validExecutions)}/${plannedExecutions} valid, ${String(reliability.exactMetering)}/${plannedExecutions} exactly metered, core=${coreQuery.state}`,
	};
};

/**
 * Builds the paired exposure report and its one closed recommendation.
 *
 * @param input - Frozen design, randomized plan, stored runs, and route evidence.
 * @returns Sanitized evidence and an explicit exposure recommendation.
 */
export const exposureReportOf = (
	input: Readonly<{
		design: ExposureDesignType;
		plan: ExposurePlanType;
		runs: readonly RunResultType[];
		coreQuery: ExposureCoreQueryType;
		generatedAt?: string;
	}>,
): ExposureReportType => {
	const {design, plan, runs, coreQuery} = input;
	const coreByCase = new Map(coreQuery.cases.map((testCase) => [testCase.caseId, testCase.coreMs]));
	const trajectories = runs.map((run) => trajectoryOf(run, coreByCase));
	const plannedExecutions = design.cases.length * design.repetitions * 2;
	const reliability = reliabilityOf(trajectories, plannedExecutions);
	const directSurface = surfaceOf(trajectories, 'direct-mcp');
	const codeModeSurface = surfaceOf(trajectories, 'code-mode');
	const metricOf = (metric: ExposureMetricNameType): ExposureMetricComparisonType => metricComparisonOf(trajectories, metric, design.digest);
	const metrics = {
		totalTaskCostUsd: metricOf('totalTaskCostUsd'),
		requestBytes: metricOf('requestBytes'),
		responseBytes: metricOf('responseBytes'),
		toolCalls: metricOf('toolCalls'),
		wallTimeMs: metricOf('wallTimeMs'),
		coreQueryMs: metricOf('coreQueryMs'),
	} satisfies Record<ExposureMetricNameType, ExposureMetricComparisonType>;
	const correctness = correctnessOf(trajectories, design);
	const outcome = decisionOf({design, reliability, metrics, correctness, directSurface, codeModeSurface, coreQuery, plannedExecutions});
	const cost = metrics.totalTaskCostUsd;

	return {
		recordType: 'exposure-comparison-report',
		schemaVersion: 1,
		claimClass: 'hosted-model-scoped',
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		design: {id: design.id, digest: design.digest, frozenAt: design.frozenAt},
		campaign: runs[0] === undefined ? null : {id: runs[0].campaignId, slotIdentityDigest: runs[0].identityDigest},
		contract: design.contract,
		suite: design.suite,
		model: design.model,
		artifact: design.artifact,
		ordinaryTools: design.ordinaryTools,
		tariff: design.tariff,
		frozenProduction: design.frozenProduction,
		plan: {seed: plan.seed, sourceDigest: plan.sourceDigest, plannedExecutions, pairs: plan.pairs},
		coreQuery,
		surfaces: {direct: directSurface, codeMode: codeModeSurface},
		reliability,
		trajectories,
		metrics,
		correctness,
		decision: {
			recommendation: outcome.recommendation,
			action: outcome.action,
			reason: outcome.reason,
			scope: `artifact ${design.artifact.id}@${design.artifact.digest} under ${design.model.reference} (${design.model.runtime}) on ${design.cases.length} fixed case(s) x ${design.repetitions} pair(s), subject ${design.suite.revision}`,
			changesCertification: false,
			evidence: [
				`cost-ratio=${String(cost.ratio.value)} upper=${String(cost.oneSidedUpper95)}`,
				`request-bytes-ratio=${String(metrics.requestBytes.ratio.value)}`,
				`response-bytes-ratio=${String(metrics.responseBytes.ratio.value)}`,
				`tool-calls-ratio=${String(metrics.toolCalls.ratio.value)}`,
				`wall-time-ratio=${String(metrics.wallTimeMs.ratio.value)}`,
				`core-query=${coreQuery.state}`,
				`correctness=${correctness.gate.detail}`,
			],
		},
		limitations: limitationsOf(),
	};
};
