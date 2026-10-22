import {type AnalysisType, type ClassReportType, type PairedMetricType, type ReportType, type ThresholdType} from './report.ts';
import {type CaseClassType} from './schema.ts';
import {
	assertLocalClaimClass,
	LOCAL_CLAIM_CLASS,
	LOCAL_REGRESSION_CASE_COUNT,
	LOCAL_REGRESSION_EXECUTIONS,
	LOCAL_REGRESSION_REPETITIONS,
	LOCAL_REGRESSION_TREATMENT_IDS,
	metricDeltaOf,
	metricRecordOf,
	TRACKED_METRICS,
	type MetricDeltaType,
	type TrackedMetricType,
} from './localContract.ts';
import {type TargetedDiagnosticReportType} from './localDiagnostic.ts';

/** One observed regression or gate failure that requires targeted diagnosis. */
export type LocalFindingType = Readonly<{
	scope: 'overall' | 'class';
	caseClass: CaseClassType | null;
	caseId: string | null;
	kind: 'target' | 'metric' | 'correctness' | 'threshold';
	metric: TrackedMetricType | null;
	baseline: number | null;
	treatment: number | null;
	ratio: number | null;
	/** True for a point-increase observation. */
	observed: boolean;
	/** True only when a paired interval excludes parity in the harmful direction. */
	statisticallySupported: boolean;
	detail: string;
}>;

/** One overall or class-stratified local trend. */
export type LocalTrendType = Readonly<{
	scope: 'overall' | 'class';
	caseClass: CaseClassType | null;
	caseIds: readonly string[];
	success: Readonly<{noIndex: number; accepted: number; candidate: number}>;
	targetMetric: TrackedMetricType;
	target: MetricDeltaType;
	metrics: Readonly<Record<TrackedMetricType, MetricDeltaType>>;
	/** Observed candidate-versus-accepted metric regressions for this scope. */
	regressions: readonly LocalFindingType[];
	passed: boolean;
}>;

/** Class-stratified local regression record. */
export type LocalRegressionReportType = Readonly<{
	recordType: 'local-regression';
	schemaVersion: 1;
	claimClass: typeof LOCAL_CLAIM_CLASS;
	/** A local run never carries release authority. */
	releaseAuthority: false;
	suite: Readonly<{id: string; version: number; hash: string}>;
	model: string;
	environment: Readonly<{id: string; hash: string}>;
	targetMetric: TrackedMetricType;
	diagnostic: Readonly<{runId: string; digest: string; passed: boolean; targetImproved: boolean}>;
	plan: Readonly<{
		caseCount: number;
		treatments: readonly string[];
		repetitions: number;
		expectedExecutions: number;
		executions: number;
		validExecutions: number;
	}>;
	report: Readonly<{campaignId: string; comparisonDigest: string; identityDigests: readonly string[]}>;
	trends: readonly LocalTrendType[];
	regressions: readonly LocalFindingType[];
	/** True when any observed regression or gate failure requires targeted diagnosis. */
	diagnosisRequired: boolean;
	passed: boolean;
	blocking: readonly string[];
}>;

/** Input for one local regression record. */
export type LocalRegressionInputType = Readonly<{
	diagnostic: TargetedDiagnosticReportType;
	report: ReportType;
	targetMetric: TrackedMetricType;
	diagnosticRunId: string;
	diagnosticDigest: string;
}>;

type TrendInputType = Readonly<{
	scope: LocalTrendType['scope'];
	caseClass: CaseClassType | null;
	caseIds: readonly string[];
	analysis: AnalysisType;
	targetMetric: TrackedMetricType;
}>;

const metricFindingsOf = (input: TrendInputType): readonly LocalFindingType[] =>
	TRACKED_METRICS.flatMap((metric): readonly LocalFindingType[] => {
		const paired: PairedMetricType = input.analysis.paired.candidateVsAccepted.metrics[metric];

		if (paired.medianRatio === null || paired.medianRatio <= 1) {
			return [];
		}

		return [
			{
				scope: input.scope,
				caseClass: input.caseClass,
				caseId: null,
				kind: 'metric',
				metric,
				baseline: paired.baselineMedian,
				treatment: paired.treatmentMedian,
				ratio: paired.medianRatio,
				observed: true,
				statisticallySupported: paired.ratioInterval95 !== null && paired.ratioInterval95.low > 1,
				detail: `${metric} candidate/accepted ratio ${paired.medianRatio.toFixed(3)} (n=${paired.pairCount})`,
			},
		];
	});

const trendOf = (input: TrendInputType): LocalTrendType => {
	const metrics = metricRecordOf((metric) => {
		const paired = input.analysis.paired.candidateVsAccepted.metrics[metric];

		return metricDeltaOf(paired.baselineMedian, paired.treatmentMedian);
	});
	const regressions = metricFindingsOf(input);

	return {
		scope: input.scope,
		caseClass: input.caseClass,
		caseIds: input.caseIds,
		success: {
			noIndex: input.analysis.noIndex.successRate,
			accepted: input.analysis.accepted.successRate,
			candidate: input.analysis.candidate.successRate,
		},
		targetMetric: input.targetMetric,
		target: metrics[input.targetMetric],
		metrics,
		regressions,
		passed: regressions.every((finding) => !finding.statisticallySupported),
	};
};

const correctnessFindingOf = (delta: AnalysisType['caseDeltas'][number], baseline: number, baselineName: string): readonly LocalFindingType[] =>
	delta.candidate < baseline
		? [
				{
					scope: 'overall',
					caseClass: delta.caseClass,
					caseId: delta.caseId,
					kind: 'correctness',
					metric: null,
					baseline,
					treatment: delta.candidate,
					ratio: null,
					observed: true,
					statisticallySupported: true,
					detail: `${delta.caseId} candidate success ${delta.candidate} below ${baselineName} ${baseline}`,
				},
			]
		: [];

const correctnessFindingsOf = (report: ReportType): readonly LocalFindingType[] =>
	report.caseDeltas.flatMap((delta) => [...correctnessFindingOf(delta, delta.accepted, 'accepted'), ...correctnessFindingOf(delta, delta.noIndex, 'no-index')]);

const thresholdFindingsOf = (thresholds: readonly ThresholdType[]): readonly LocalFindingType[] =>
	thresholds
		.filter((threshold) => !threshold.passed)
		.map((threshold) => ({
			scope: 'overall',
			caseClass: null,
			caseId: null,
			kind: 'threshold',
			metric: null,
			baseline: null,
			treatment: null,
			ratio: null,
			observed: true,
			statisticallySupported: true,
			detail: `${threshold.name} (${threshold.detail})`,
		}));

const targetFindingsOf = (targetMetric: TrackedMetricType, target: MetricDeltaType): readonly LocalFindingType[] =>
	target.improved
		? []
		: [
				{
					scope: 'overall',
					caseClass: null,
					caseId: null,
					kind: 'target',
					metric: targetMetric,
					baseline: target.accepted,
					treatment: target.candidate,
					ratio: target.ratio,
					observed: true,
					statisticallySupported: false,
					detail: `target metric ${targetMetric} did not improve (accepted ${target.accepted ?? 'unavailable'}, candidate ${target.candidate ?? 'unavailable'})`,
				},
			];

/**
 * Builds the class-stratified local regression record.
 *
 * Local evidence is never release evidence: the record carries the
 * local-model claim class and no release authority, so a hosted result cannot
 * override it and it cannot stand in for a hosted campaign.
 *
 * A statistically supported candidate regression, a failed gate, a correctness
 * loss, or a non-improving target metric triggers targeted diagnosis. Point-only
 * increases are retained as observations and do not fail the stage by
 * themselves, because one case pair cannot support an interval.
 *
 * @param input - Passed diagnostic, complete paired report, and pinned identity.
 * @returns The local regression record.
 */
export const localRegressionReportOf = (input: LocalRegressionInputType): LocalRegressionReportType => {
	assertLocalClaimClass(input.report.campaign.claimClass);

	if (input.diagnostic.targetMetric !== input.targetMetric) {
		throw new Error(`diagnostic target ${input.diagnostic.targetMetric} differs from regression target ${input.targetMetric}`);
	}

	const overall = trendOf({
		scope: 'overall',
		caseClass: null,
		caseIds: [...new Set(input.report.runs.map((run) => run.caseId))].sort(),
		analysis: input.report,
		targetMetric: input.targetMetric,
	});
	const trends = [
		overall,
		...input.report.classes.map((report: ClassReportType) =>
			trendOf({scope: 'class', caseClass: report.class, caseIds: report.caseIds, analysis: report, targetMetric: input.targetMetric}),
		),
	];
	const {target} = overall;
	const targetImproved = target.improved;
	const classRegressions = trends.flatMap((trend) => (trend.scope === 'class' ? trend.regressions : []));
	const regressions = [
		...overall.regressions,
		...classRegressions,
		...correctnessFindingsOf(input.report),
		...thresholdFindingsOf(input.report.thresholds),
		...targetFindingsOf(input.targetMetric, target),
	];
	const supported = regressions.filter((finding) => finding.statisticallySupported);
	const caseCount = new Set(input.report.runs.map((run) => run.caseId)).size;
	const treatmentIds = [...new Set(input.report.runs.map((run) => run.treatment))].sort();
	const expectedTreatments = [...LOCAL_REGRESSION_TREATMENT_IDS].sort();
	const repetitions = Math.max(...input.report.runs.map((run) => run.repetition));
	const invalidExecutions = input.report.runs.filter((run) => !run.evidence).length;
	const completePlan =
		input.report.runs.length === LOCAL_REGRESSION_EXECUTIONS &&
		caseCount === LOCAL_REGRESSION_CASE_COUNT &&
		treatmentIds.join(',') === expectedTreatments.join(',') &&
		repetitions === LOCAL_REGRESSION_REPETITIONS;
	const blocking = [
		...(completePlan
			? []
			: [
					`incomplete local regression plan: ${input.report.runs.length}/${LOCAL_REGRESSION_EXECUTIONS} executions, ${caseCount} case(s), treatments ${treatmentIds.join(', ')}, ${repetitions} repetition(s)`,
				]),
		...(invalidExecutions === 0 ? [] : [`invalid executions: ${invalidExecutions}`]),
		...(input.diagnostic.passed ? [] : [`targeted diagnostic blocked: ${input.diagnostic.blocking.join('; ')}`]),
		...supported.map((finding) => finding.detail),
		...(targetImproved ? [] : [`target metric ${input.targetMetric} did not improve`]),
	];
	const {campaign, sources, runs} = input.report;

	return {
		recordType: 'local-regression',
		schemaVersion: 1,
		claimClass: LOCAL_CLAIM_CLASS,
		releaseAuthority: false,
		suite: campaign.suite,
		model: input.diagnostic.model,
		environment: input.diagnostic.environment,
		targetMetric: input.targetMetric,
		diagnostic: {
			runId: input.diagnosticRunId,
			digest: input.diagnosticDigest,
			passed: input.diagnostic.passed,
			targetImproved: input.diagnostic.targetImproved,
		},
		plan: {
			caseCount,
			treatments: treatmentIds,
			repetitions,
			expectedExecutions: LOCAL_REGRESSION_EXECUTIONS,
			executions: runs.length,
			validExecutions: runs.filter((run) => run.evidence).length,
		},
		report: {
			campaignId: campaign.campaignId,
			comparisonDigest: sources.comparisonDigest,
			identityDigests: sources.identityDigests,
		},
		trends,
		regressions,
		diagnosisRequired: regressions.length > 0,
		passed: blocking.length === 0,
		blocking,
	};
};

/**
 * Describes the local verdict in one bounded line.
 *
 * @param report - Local regression record.
 * @returns A summary naming the class trends and every blocking finding.
 */
export const localRegressionSummaryOf = (report: LocalRegressionReportType): string => {
	const trends = report.trends
		.filter((trend) => trend.scope === 'class')
		.map((trend) => {
			const ratio = trend.target.ratio === null ? 'n/a' : trend.target.ratio.toFixed(3);

			return `${trend.caseClass} ${trend.targetMetric}=${ratio}`;
		})
		.join(', ');
	const blocking = report.blocking.length === 0 ? 'no blocking regression' : report.blocking.join('; ');

	return `claim ${report.claimClass} release-authority=no; classes ${trends}; ${blocking}`;
};
