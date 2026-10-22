/** Availability of one telemetry entry. */
export type CalibrationMetricStateType = 'exact' | 'unavailable' | 'not-applicable';

/** One telemetry entry, exact or explicitly unavailable. */
export type CalibrationMetricType = Readonly<{value: number | null; state: CalibrationMetricStateType}>;

/**
 * Retained execution facts a calibration decision needs.
 *
 * This is a structural subset of the stored result, so the decision can be
 * tested without fabricating unrelated fields.
 */
export type CalibrationExecutionType = Readonly<{
	caseId: string;
	treatment: string;
	repetition: number;
	valid: boolean;
	defects: readonly string[];
	outcome: string;
	timedOut: boolean;
	invalidReason: string | null;
	isolation: Readonly<{restored: boolean}>;
	attempts: readonly unknown[];
	grade: Readonly<{success: boolean}>;
	telemetry:
		| Readonly<{
				inputTokens: CalibrationMetricType;
				outputTokens: CalibrationMetricType;
				reasoningTokens: CalibrationMetricType;
		  }>
		| undefined;
	usage: Readonly<{available: boolean; input: number; output: number; reasoning: number}>;
	durationMs: number;
	familyBytes: Readonly<{index: number; search: number; read: number; list: number}>;
	toolCalls: readonly unknown[];
}>;

/** One local model's qualification outcome under the frozen calibration budget. */
export type CalibrationDecisionType = Readonly<{
	model: string;
	environment: Readonly<{id: string; hash: string}>;
	budgetMs: number;
	elapsedMs: number;
	plannedSlots: number;
	executedSlots: number;
	validExecutions: number;
	noIndexExact: number;
	acceptedExact: number;
	correctnessLossCases: readonly string[];
	interventions: readonly string[];
	telemetry: Readonly<{tokenState: CalibrationMetricStateType; limitation: string | null}>;
	acceptedMedianWallMs: number;
	acceptedMedianRetrievalBytes: number;
	acceptedMedianToolCalls: number;
	passed: boolean;
	disqualification: string | null;
}>;

/** Predeclared ordering across local candidates. */
export type CalibrationSelectionType = Readonly<{
	selected: string | null;
	qualified: readonly string[];
	reason: string;
}>;

/** A candidate the operator ruled out before any execution. */
export type CalibrationExclusionType = Readonly<{
	model: string;
	environment: Readonly<{id: string; hash: string}>;
	budgetMs: number;
	reason: string;
}>;

/** Inputs needed to record a candidate that was not executed. */
export type CalibrationDisqualificationInputType = Readonly<{
	model: string;
	environmentId: string;
	environmentHash: string;
	budgetMs: number;
	plannedSlots: number;
	reason: string;
}>;

/** Inputs needed to decide one model from its retained executions. */
export type CalibrationDecisionInputType = Readonly<{
	model: string;
	environmentId: string;
	environmentHash: string;
	budgetMs: number;
	elapsedMs: number;
	plannedSlots: number;
	results: readonly CalibrationExecutionType[];
}>;

const isEvidenceRun = (run: CalibrationExecutionType): boolean => run.valid && run.defects.length === 0 && run.outcome !== 'aborted';

const runKeyOf = (run: CalibrationExecutionType): string => `${run.caseId}/${run.treatment}/rep-${run.repetition}`;

const medianOf = (values: readonly number[]): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

const tokenStateOf = (run: CalibrationExecutionType): CalibrationMetricStateType => {
	if (run.telemetry === undefined) {
		return run.usage.available ? 'exact' : 'unavailable';
	}

	const entries = [run.telemetry.inputTokens, run.telemetry.outputTokens, run.telemetry.reasoningTokens];

	if (entries.every((entry) => entry.state === 'not-applicable')) {
		return 'not-applicable';
	}

	return entries.every((entry) => entry.state === 'exact' && entry.value !== null) ? 'exact' : 'unavailable';
};

/**
 * Lists every execution that needed harness or operator intervention.
 *
 * A retry, timeout, invalid result, non-restored workspace, or recorded defect
 * is an intervention. None may be hidden by an otherwise correct answer.
 *
 * @param results - Retained calibration executions.
 * @returns One bounded reason per affected execution.
 */
const interventionsOf = (results: readonly CalibrationExecutionType[]): readonly string[] => {
	const reasons: string[] = [];

	for (const run of results) {
		if (run.attempts.length > 1) {
			reasons.push(`${runKeyOf(run)}: retried ${run.attempts.length - 1} time(s)`);
		}

		if (run.timedOut) {
			reasons.push(`${runKeyOf(run)}: timed out`);
		}

		if (!run.valid) {
			reasons.push(`${runKeyOf(run)}: ${run.invalidReason ?? 'invalid'}`);
		}

		if (!run.isolation.restored) {
			reasons.push(`${runKeyOf(run)}: workspace not restored`);
		}

		if (run.defects.length > 0) {
			reasons.push(`${runKeyOf(run)}: defect(s) ${run.defects.join(', ')}`);
		}

		if (run.outcome === 'aborted') {
			reasons.push(`${runKeyOf(run)}: aborted`);
		}
	}

	return [...new Set(reasons)].sort();
};

/**
 * Finds cases where the accepted treatment is less correct than no-index.
 *
 * Correctness loss is paired by case, as in the Q2 gates. A case that fails in
 * both treatments is a model limitation, not a loss against the baseline.
 *
 * @param results - Retained calibration executions.
 * @returns Case ids whose accepted answer lost a correct no-index answer.
 */
const correctnessLossOf = (results: readonly CalibrationExecutionType[]): readonly string[] => {
	const caseIds = [...new Set(results.map((run) => run.caseId))].sort();
	const losses: string[] = [];

	for (const caseId of caseIds) {
		const noIndex = results.find((run) => run.caseId === caseId && run.treatment === 'no-index' && isEvidenceRun(run));
		const accepted = results.find((run) => run.caseId === caseId && run.treatment === 'accepted' && isEvidenceRun(run));

		if (noIndex?.grade.success === true && accepted?.grade.success !== true) {
			losses.push(caseId);
		}
	}

	return losses;
};

/**
 * Decides whether one local model qualifies for prechecks.
 *
 * Qualification requires every planned execution, every execution valid, no
 * correctness loss against no-index, no intervention, and completion inside
 * the declared wall-clock budget. Telemetry gaps are reported separately and
 * never estimated.
 *
 * @param input - Model, environment, budget, elapsed time, and retained results.
 * @returns The qualification decision and the facts a selection record cites.
 */
export const calibrationDecisionOf = (input: CalibrationDecisionInputType): CalibrationDecisionType => {
	const valid = input.results.filter(isEvidenceRun);
	const accepted = valid.filter((run) => run.treatment === 'accepted');
	const noIndex = valid.filter((run) => run.treatment === 'no-index');
	const correctnessLossCases = correctnessLossOf(input.results);
	const interventions = interventionsOf(input.results);
	const tokenStates = [...noIndex, ...accepted].map((run) => tokenStateOf(run));
	const tokenState: CalibrationMetricStateType =
		tokenStates.length > 0 && tokenStates.every((state) => state === 'exact')
			? 'exact'
			: tokenStates.length > 0 && tokenStates.every((state) => state === 'not-applicable')
				? 'not-applicable'
				: 'unavailable';
	const limitation =
		tokenState === 'exact' ? null : `token usage is ${tokenState}; token metrics are invalid, while correctness, calls, bytes, and latency remain usable`;
	const reasons: string[] = [];

	if (input.elapsedMs > input.budgetMs) {
		reasons.push(`budget exceeded: ${input.elapsedMs} ms > ${input.budgetMs} ms`);
	}

	if (input.results.length !== input.plannedSlots) {
		reasons.push(`incomplete: ${input.results.length}/${input.plannedSlots} executions`);
	}

	if (valid.length !== input.plannedSlots) {
		reasons.push(`invalid executions: ${input.plannedSlots - valid.length}/${input.plannedSlots}`);
	}

	if (correctnessLossCases.length > 0) {
		reasons.push(`correctness loss on ${correctnessLossCases.join(', ')}`);
	}

	if (interventions.length > 0) {
		reasons.push(`interventions required: ${interventions.length}`);
	}

	return {
		model: input.model,
		environment: {id: input.environmentId, hash: input.environmentHash},
		budgetMs: input.budgetMs,
		elapsedMs: input.elapsedMs,
		plannedSlots: input.plannedSlots,
		executedSlots: input.results.length,
		validExecutions: valid.length,
		noIndexExact: noIndex.filter((run) => run.grade.success).length,
		acceptedExact: accepted.filter((run) => run.grade.success).length,
		correctnessLossCases,
		interventions,
		telemetry: {tokenState, limitation},
		acceptedMedianWallMs: medianOf(accepted.map((run) => run.durationMs)),
		acceptedMedianRetrievalBytes: medianOf(accepted.map((run) => run.familyBytes.index + run.familyBytes.search + run.familyBytes.read + run.familyBytes.list)),
		acceptedMedianToolCalls: medianOf(accepted.map((run) => run.toolCalls.length)),
		passed: reasons.length === 0,
		disqualification: reasons.length === 0 ? null : reasons.join('; '),
	};
};

/**
 * Records a candidate that received no qualification execution.
 *
 * An excluded or diagnostically blocked candidate must stay visible in the
 * selection record; dropping it would silently narrow the candidate set.
 *
 * @param input - Model, environment, budget, planned slots, and the reason.
 * @returns A non-qualifying decision with zero executions.
 */
export const calibrationDisqualificationOf = (input: CalibrationDisqualificationInputType): CalibrationDecisionType => ({
	model: input.model,
	environment: {id: input.environmentId, hash: input.environmentHash},
	budgetMs: input.budgetMs,
	elapsedMs: 0,
	plannedSlots: input.plannedSlots,
	executedSlots: 0,
	validExecutions: 0,
	noIndexExact: 0,
	acceptedExact: 0,
	correctnessLossCases: [],
	interventions: [],
	telemetry: {tokenState: 'not-applicable', limitation: 'no execution was attempted'},
	acceptedMedianWallMs: 0,
	acceptedMedianRetrievalBytes: 0,
	acceptedMedianToolCalls: 0,
	passed: false,
	disqualification: input.reason,
});

/**
 * Selects one local reference from the calibration decisions.
 *
 * The order is fixed before execution: qualifiers only, then more exact
 * accepted answers, then lower accepted median wall time, then lower accepted
 * median retrieval bytes, then the model reference for a stable tie-break.
 *
 * @param decisions - One decision per calibrated model.
 * @returns The selected model and the rule that selected it.
 */
export const calibrationSelectionOf = (decisions: readonly CalibrationDecisionType[]): CalibrationSelectionType => {
	const qualified = decisions
		.filter((decision) => decision.passed)
		.sort(
			(left, right) =>
				right.acceptedExact - left.acceptedExact ||
				left.acceptedMedianWallMs - right.acceptedMedianWallMs ||
				left.acceptedMedianRetrievalBytes - right.acceptedMedianRetrievalBytes ||
				left.model.localeCompare(right.model),
		);
	const [selected] = qualified;

	if (selected === undefined) {
		return {selected: null, qualified: [], reason: 'no calibrated model qualified under the frozen budget'};
	}

	return {
		selected: selected.model,
		qualified: qualified.map((decision) => decision.model),
		reason: `most exact accepted answers (${selected.acceptedExact}), then lowest accepted median wall time (${selected.acceptedMedianWallMs} ms), then lowest accepted retrieval bytes (${selected.acceptedMedianRetrievalBytes})`,
	};
};
