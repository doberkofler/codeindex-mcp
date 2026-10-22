import {median, metricValueOf, type PairedMetricNameType, PAIRED_METRICS} from './reportMetrics.ts';
import {type RunResultType} from './runTypes.ts';

/** Claim class of every local-model campaign. */
export const LOCAL_CLAIM_CLASS = 'local-model-scoped' as const;

/** Two impact cases predeclared for the accepted-versus-candidate diagnostic. */
export const TARGETED_DIAGNOSTIC_CASE_IDS = ['impact-build-generation-references', 'impact-schema-version-references'] as const;

/** Treatments compared by the targeted diagnostic. */
export const TARGETED_DIAGNOSTIC_TREATMENT_IDS = ['accepted', 'candidate'] as const;

/** One repetition per case and treatment: four executions. */
export const TARGETED_DIAGNOSTIC_REPETITIONS = 1;

/** Fixed executions required by the targeted diagnostic. */
export const TARGETED_DIAGNOSTIC_EXECUTIONS = TARGETED_DIAGNOSTIC_CASE_IDS.length * TARGETED_DIAGNOSTIC_TREATMENT_IDS.length * TARGETED_DIAGNOSTIC_REPETITIONS;

/** Frozen release suite size used by the local regression. */
export const LOCAL_REGRESSION_CASE_COUNT = 18;

/** Treatments compared by the local regression. */
export const LOCAL_REGRESSION_TREATMENT_IDS = ['no-index', 'accepted', 'candidate'] as const;

/** Paired repetitions used by the local regression. */
export const LOCAL_REGRESSION_REPETITIONS = 3;

/** Fixed executions required by the local regression. */
export const LOCAL_REGRESSION_EXECUTIONS = LOCAL_REGRESSION_CASE_COUNT * LOCAL_REGRESSION_TREATMENT_IDS.length * LOCAL_REGRESSION_REPETITIONS;

/** Metrics tracked by both local stages. Lower is better for every one. */
export type TrackedMetricType = PairedMetricNameType;

/** One tracked metric with its measured medians and relative change. */
export type MetricDeltaType = Readonly<{
	accepted: number | null;
	candidate: number | null;
	delta: number | null;
	ratio: number | null;
	improved: boolean;
	regressed: boolean;
}>;

/**
 * Rejects a report that does not carry local-model claim authority.
 *
 * Hosted and local evidence are never interchangeable: a local run cannot be
 * promoted, and a hosted run cannot stand in for a local regression.
 *
 * @param claimClass - Claim class read from the campaign manifest.
 */
export const assertLocalClaimClass = (claimClass: string): void => {
	if (claimClass !== LOCAL_CLAIM_CLASS) {
		throw new Error(`expected ${LOCAL_CLAIM_CLASS} evidence, found "${claimClass}"`);
	}
};

export const metricDeltaOf = (accepted: number | null, candidate: number | null): MetricDeltaType => {
	if (accepted === null || candidate === null) {
		return {accepted, candidate, delta: null, ratio: null, improved: false, regressed: false};
	}

	return {
		accepted,
		candidate,
		delta: candidate - accepted,
		ratio: accepted === 0 ? null : candidate / accepted,
		improved: candidate < accepted,
		regressed: candidate > accepted,
	};
};

export const medianOf = (results: readonly RunResultType[], treatment: string, metric: TrackedMetricType, caseId?: string): number | null => {
	const values = results
		.filter((run) => run.treatment === treatment && (caseId === undefined || run.caseId === caseId))
		.map((run) => metricValueOf(run, metric))
		.filter((value): value is number => value !== null);

	return values.length === 0 ? null : median(values);
};

/**
 * Builds one explicit entry per tracked metric without widening the record type.
 *
 * @param valueOf - Produces the value for one tracked metric.
 * @returns A record containing every tracked metric.
 */
export const metricRecordOf = <Value>(valueOf: (metric: TrackedMetricType) => Value): Readonly<Record<TrackedMetricType, Value>> => ({
	retrievalBytes: valueOf('retrievalBytes'),
	toolCalls: valueOf('toolCalls'),
	tokens: valueOf('tokens'),
	wallTimeMs: valueOf('wallTimeMs'),
});

/** Every tracked metric in report order. */
export const TRACKED_METRICS: readonly TrackedMetricType[] = PAIRED_METRICS;

/**
 * Metrics whose value the artifact controls, so an observed increase blocks the
 * targeted diagnostic.
 *
 * Token counts and wall-clock time stay outside this set. A single execution per
 * treatment cannot separate them from model sampling and local runtime variation,
 * so the diagnostic records them for review instead of turning noise into a gate
 * verdict.
 */
export const BLOCKING_METRICS: readonly TrackedMetricType[] = ['retrievalBytes', 'toolCalls'];
