import {type DiagnosticReportType, diagnosticReportOf, diagnosticSummaryOf} from './diagnostics.ts';
import {type CaseClassType} from './schema.ts';
import {
	BLOCKING_METRICS,
	LOCAL_CLAIM_CLASS,
	medianOf,
	metricDeltaOf,
	metricRecordOf,
	TARGETED_DIAGNOSTIC_CASE_IDS,
	TARGETED_DIAGNOSTIC_REPETITIONS,
	TARGETED_DIAGNOSTIC_TREATMENT_IDS,
	TRACKED_METRICS,
	type MetricDeltaType,
	type TrackedMetricType,
} from './localContract.ts';
import {type RunResultType} from './runTypes.ts';

/** Per-case metric values retained for audit. */
export type CaseMetricValuesType = Readonly<{
	caseId: string;
	caseClass: CaseClassType;
	metrics: Readonly<Record<TrackedMetricType, MetricDeltaType>>;
}>;

/** Input for one targeted diagnostic record. */
export type TargetedDiagnosticInputType = Readonly<{
	results: readonly RunResultType[];
	suite: Readonly<{id: string; version: number; hash: string}>;
	model: string;
	environment: Readonly<{id: string; hash: string}>;
	targetMetric: TrackedMetricType;
	caseIds?: readonly string[];
	treatments?: readonly string[];
	repetitions?: number;
}>;

/** Attributed four-execution accepted-versus-candidate diagnostic. */
export type TargetedDiagnosticReportType = Readonly<{
	recordType: 'targeted-diagnostic';
	schemaVersion: 1;
	claimClass: typeof LOCAL_CLAIM_CLASS;
	suite: Readonly<{id: string; version: number; hash: string}>;
	model: string;
	environment: Readonly<{id: string; hash: string}>;
	targetMetric: TrackedMetricType;
	cases: readonly string[];
	treatments: readonly string[];
	repetitions: number;
	expectedExecutions: number;
	executions: number;
	validExecutions: number;
	/** Execution-contract attribution shared with the calibration diagnostics. */
	contract: DiagnosticReportType;
	correctness: Readonly<{
		acceptedCorrect: boolean;
		candidateCorrect: boolean;
		incorrectCandidateCases: readonly string[];
	}>;
	metrics: Readonly<Record<TrackedMetricType, MetricDeltaType>>;
	caseMetrics: readonly CaseMetricValuesType[];
	targetImproved: boolean;
	/** Every observed regression, including token and wall-clock observations. */
	regressions: readonly string[];
	/** The subset of regressions that block continuation. */
	blockingRegressions: readonly string[];
	passed: boolean;
	blocking: readonly string[];
}>;

type CorrectnessType = TargetedDiagnosticReportType['correctness'];

const caseMetricsOf = (results: readonly RunResultType[], caseIds: readonly string[]): readonly CaseMetricValuesType[] =>
	caseIds.map((caseId) => ({
		caseId,
		caseClass: results.find((run) => run.caseId === caseId)?.caseClass ?? 'impact',
		metrics: metricRecordOf((metric) => metricDeltaOf(medianOf(results, 'accepted', metric, caseId), medianOf(results, 'candidate', metric, caseId))),
	}));

const correctnessOf = (results: readonly RunResultType[], caseCount: number, repetitions: number): CorrectnessType => {
	const accepted = results.filter((run) => run.treatment === 'accepted');
	const candidate = results.filter((run) => run.treatment === 'candidate');
	const incorrectCandidateCases = [...new Set(candidate.filter((run) => !run.grade.success).map((run) => run.caseId))].sort();

	return {
		acceptedCorrect: accepted.length > 0 && accepted.every((run) => run.grade.success),
		candidateCorrect: candidate.length === caseCount * repetitions && incorrectCandidateCases.length === 0,
		incorrectCandidateCases,
	};
};

const regressionsOf = (
	metrics: Readonly<Record<TrackedMetricType, MetricDeltaType>>,
	caseMetrics: readonly CaseMetricValuesType[],
	tracked: readonly TrackedMetricType[] = TRACKED_METRICS,
): readonly string[] => {
	const regressions = tracked
		.filter((metric) => metrics[metric].regressed)
		.map((metric) => `overall ${metric} regressed from ${metrics[metric].accepted ?? 'unavailable'} to ${metrics[metric].candidate ?? 'unavailable'}`);

	for (const caseMetric of caseMetrics) {
		for (const metric of tracked) {
			const delta = caseMetric.metrics[metric];

			if (delta.regressed) {
				regressions.push(`${caseMetric.caseId} ${metric} regressed from ${delta.accepted ?? 'unavailable'} to ${delta.candidate ?? 'unavailable'}`);
			}
		}
	}

	return regressions;
};

/**
 * Builds the four-execution accepted-versus-candidate diagnostic record.
 *
 * Continuation requires a clean execution contract, a correct candidate answer
 * on every selected case, a strict improvement of the predeclared target
 * metric, and no regression of a metric the artifact controls. Token and
 * wall-clock differences are still recorded, but one repetition at the pinned
 * generation settings cannot separate them from model sampling and local
 * runtime variation, so they do not block continuation.
 *
 * @param input - Retained executions and their pinned identity.
 * @returns The diagnostic record, including every observed and every blocking reason.
 */
export const targetedDiagnosticReportOf = (input: TargetedDiagnosticInputType): TargetedDiagnosticReportType => {
	const cases = input.caseIds ?? TARGETED_DIAGNOSTIC_CASE_IDS;
	const treatments = input.treatments ?? TARGETED_DIAGNOSTIC_TREATMENT_IDS;
	const repetitions = input.repetitions ?? TARGETED_DIAGNOSTIC_REPETITIONS;
	const contract = diagnosticReportOf(input.results, cases, repetitions, treatments);
	const correctness = correctnessOf(input.results, cases.length, repetitions);
	const metrics = metricRecordOf((metric) => metricDeltaOf(medianOf(input.results, 'accepted', metric), medianOf(input.results, 'candidate', metric)));
	const caseMetrics = caseMetricsOf(input.results, cases);
	const target = metrics[input.targetMetric];
	const targetImproved = target.improved;
	const regressions = regressionsOf(metrics, caseMetrics);
	const blockingRegressions = regressionsOf(metrics, caseMetrics, BLOCKING_METRICS);
	const blocking = [
		...(contract.passed ? [] : [`execution contract: ${diagnosticSummaryOf(contract)}`]),
		...(correctness.candidateCorrect
			? []
			: [
					`candidate answer incorrect on ${correctness.incorrectCandidateCases.length === 0 ? 'a missing execution' : correctness.incorrectCandidateCases.join(', ')}`,
				]),
		...(targetImproved
			? []
			: [`target metric ${input.targetMetric} did not improve (accepted ${target.accepted ?? 'unavailable'}, candidate ${target.candidate ?? 'unavailable'})`]),
		...blockingRegressions,
	];

	return {
		recordType: 'targeted-diagnostic',
		schemaVersion: 1,
		claimClass: LOCAL_CLAIM_CLASS,
		suite: input.suite,
		model: input.model,
		environment: input.environment,
		targetMetric: input.targetMetric,
		cases,
		treatments,
		repetitions,
		expectedExecutions: contract.expectedExecutions,
		executions: contract.executions,
		validExecutions: contract.validExecutions,
		contract,
		correctness,
		metrics,
		caseMetrics,
		targetImproved,
		regressions,
		blockingRegressions,
		passed: blocking.length === 0,
		blocking,
	};
};
