import {hostedReferenceHashOf} from './hostedReference.ts';
import {TRACKED_METRICS, type TrackedMetricType} from './localContract.ts';
import {type PairedMetricNameType} from './reportMetrics.ts';
import {
	RELEASE_CLAIM_CLASS,
	RELEASE_CASE_COUNT,
	RELEASE_EXECUTIONS,
	RELEASE_REPETITIONS,
	RELEASE_TREATMENT_IDS,
	type ReleaseCampaignInputType,
	type ReleaseCampaignReportType,
	type ReleaseClassVerdictType,
	type ReleaseOverallVerdictType,
	type ReleaseRegressionType,
	type ReleaseSlotType,
} from './releaseContract.ts';
import {type AnalysisType, type ClassReportType, type PairedMetricType} from './report.ts';
import {type RunResultType} from './runTypes.ts';
import {type CaseClassType} from './schema.ts';

import {assertReleaseClaimClass} from './releasePreconditions.ts';

export * from './releaseContract.ts';
export {assertReleaseClaimClass, localRegressionPreconditionOf, modelFreePreconditionOf} from './releasePreconditions.ts';

const slotKeyOf = (caseId: string, treatment: string, repetition: number): string => `${caseId}\u0000${treatment}\u0000${repetition}`;

const causeOf = (run: RunResultType): string | null => {
	if (run.valid && run.defects.length === 0 && run.outcome !== 'aborted') {
		return null;
	}

	const causes = [run.outcome, ...run.defects, ...(run.invalidReason === null ? [] : [run.invalidReason])];

	return [...new Set(causes)].join('; ');
};

const slotsOf = (input: ReleaseCampaignInputType): readonly ReleaseSlotType[] => {
	const bySlot = new Map<string, RunResultType>();

	for (const run of input.results) {
		const key = slotKeyOf(run.caseId, run.treatment, run.repetition);

		if (bySlot.has(key)) {
			throw new Error(`release campaign contains duplicate slot ${run.caseId}/${run.treatment}/rep-${run.repetition}`);
		}

		bySlot.set(key, run);
	}

	return input.expectedSlots.map((slot) => {
		const run = bySlot.get(slotKeyOf(slot.caseId, slot.treatment, slot.repetition));
		const cause = run === undefined ? 'missing execution' : causeOf(run);

		return {
			caseId: slot.caseId,
			treatment: slot.treatment,
			repetition: slot.repetition,
			status: cause === null ? 'valid' : 'invalid',
			cause,
		};
	});
};

const successOf = (analysis: AnalysisType): Readonly<{noIndex: number; accepted: number; candidate: number}> => ({
	noIndex: analysis.noIndex.successRate,
	accepted: analysis.accepted.successRate,
	candidate: analysis.candidate.successRate,
});

const regressionOf = (
	scope: ReleaseRegressionType['scope'],
	caseClass: CaseClassType | null,
	metrics: Readonly<Record<PairedMetricNameType, PairedMetricType>>,
): readonly ReleaseRegressionType[] =>
	TRACKED_METRICS.flatMap((metric) => {
		const paired = metrics[metric];
		const interval = paired.ratioInterval95;

		if (interval === null || interval.low <= 1) {
			return [];
		}

		return [
			{
				scope,
				caseClass,
				metric,
				ratio: paired.medianRatio ?? Number.POSITIVE_INFINITY,
				interval: {low: interval.low, high: interval.high, confidence: interval.confidence},
			},
		];
	});

const targetImproved = (target: PairedMetricType): boolean => target.medianRatio !== null && target.medianRatio < 1;

const verdictOf = (analysis: AnalysisType, targetMetric: TrackedMetricType): Omit<ReleaseOverallVerdictType, 'success'> => {
	const {metrics} = analysis.paired.candidateVsAccepted;
	const {thresholds} = analysis;
	const target = metrics[targetMetric];
	const regressions = regressionOf('overall', null, metrics);

	return {
		targetMetric,
		target,
		metrics,
		thresholds,
		regressions,
		passed: analysis.passed && targetImproved(target) && regressions.length === 0,
	};
};

const classVerdictOf = (report: ClassReportType, targetMetric: TrackedMetricType): ReleaseClassVerdictType => {
	const {metrics} = report.paired.candidateVsAccepted;
	const target = metrics[targetMetric];
	const regressions = regressionOf('class', report.class, metrics);

	return {
		class: report.class,
		caseIds: report.caseIds,
		success: successOf(report),
		...verdictOf(report, targetMetric),
		regressions,
		passed: report.passed && targetImproved(target) && regressions.length === 0,
	};
};

type PlanShapeType = Readonly<{
	caseCount: number;
	treatmentIds: readonly string[];
	repetitions: number;
	complete: boolean;
}>;

const planShapeOf = (expectedSlots: ReleaseCampaignInputType['expectedSlots']): PlanShapeType => {
	const caseCount = new Set(expectedSlots.map((slot) => slot.caseId)).size;
	const treatmentIds = [...new Set(expectedSlots.map((slot) => slot.treatment))].sort();
	const repetitions = Math.max(...expectedSlots.map((slot) => slot.repetition));

	return {
		caseCount,
		treatmentIds,
		repetitions,
		complete:
			expectedSlots.length === RELEASE_EXECUTIONS &&
			caseCount === RELEASE_CASE_COUNT &&
			treatmentIds.join(',') === [...RELEASE_TREATMENT_IDS].sort().join(',') &&
			repetitions === RELEASE_REPETITIONS,
	};
};

type BlockingInputType = Readonly<{
	campaign: ReleaseCampaignInputType;
	slots: readonly ReleaseSlotType[];
	shape: PlanShapeType;
	overall: Omit<ReleaseOverallVerdictType, 'success'>;
	classes: readonly ReleaseClassVerdictType[];
}>;

const blockingOf = (input: BlockingInputType): readonly string[] => [
	...(input.shape.complete
		? []
		: [
				`incomplete release plan: ${input.campaign.expectedSlots.length}/${RELEASE_EXECUTIONS} slots, ${input.shape.caseCount} case(s), treatments ${input.shape.treatmentIds.join(', ')}, ${input.shape.repetitions} repetition(s)`,
			]),
	...input.slots
		.filter((slot) => slot.status === 'invalid')
		.map((slot) => `${slot.caseId}/${slot.treatment}/rep-${slot.repetition}: ${slot.cause ?? 'invalid'}`),
	...input.campaign.report.thresholds.filter((threshold) => !threshold.passed).map((threshold) => `${threshold.name} (${threshold.detail})`),
	...input.classes.filter((verdict) => !verdict.passed).map((verdict) => `${verdict.class} class verdict failed`),
	...(targetImproved(input.overall.target) ? [] : [`target metric ${input.campaign.expectation.targetMetric} did not improve against accepted`]),
	...input.overall.regressions.map(
		(regression) =>
			`${regression.metric} candidate/accepted ratio ${regression.ratio.toFixed(3)} interval ${regression.interval.low.toFixed(3)}-${regression.interval.high.toFixed(3)}`,
	),
];

/**
 * Builds the complete hosted release campaign record.
 *
 * The record is derived only from a single fresh 270-slot campaign and the two
 * pre-release stages. Every slot is either valid or carries a closed invalidity
 * cause. The unchanged Q2 gates, the predeclared target metric, and every
 * paired-by-class bootstrap interval remain separate from the overall verdict.
 *
 * @param input - Pinned hosted reference, preconditions, planned slots, and one complete report.
 * @returns The sanitized release record.
 */
export const releaseCampaignReportOf = (input: ReleaseCampaignInputType): ReleaseCampaignReportType => {
	assertReleaseClaimClass(input.report.campaign.claimClass);

	if (input.report.runs.length === 0) {
		throw new Error('release campaign requires at least one executed slot');
	}

	const slots = slotsOf(input);
	const shape = planShapeOf(input.expectedSlots);
	const overallVerdict = verdictOf(input.report, input.expectation.targetMetric);
	const classes = input.report.classes.map((report) => classVerdictOf(report, input.expectation.targetMetric));
	const blocking = blockingOf({campaign: input, slots, shape, overall: overallVerdict, classes});
	const validExecutions = slots.filter((slot) => slot.status === 'valid').length;

	return {
		recordType: 'release-campaign',
		schemaVersion: 1,
		claimClass: RELEASE_CLAIM_CLASS,
		releaseAuthority: true,
		hosted: {
			id: input.hosted.id,
			digest: hostedReferenceHashOf(input.hosted),
			provider: input.hosted.provider,
			modelId: input.hosted.modelId,
			reference: input.hosted.reference,
			releasedAt: input.hosted.releasedAt,
		},
		suite: {id: input.expectation.suite.id, version: input.expectation.suite.version, hash: input.expectation.suite.hash},
		revision: input.expectation.suite.revision,
		targetMetric: input.expectation.targetMetric,
		preconditions: input.preconditions,
		plan: {
			caseCount: shape.caseCount,
			treatments: shape.treatmentIds,
			repetitions: shape.repetitions,
			expectedExecutions: RELEASE_EXECUTIONS,
			executions: slots.length,
			validExecutions,
			invalidExecutions: slots.length - validExecutions,
		},
		slots,
		report: {
			campaignId: input.report.campaign.campaignId,
			comparisonDigest: input.report.sources.comparisonDigest,
			identityDigests: input.report.sources.identityDigests,
		},
		paired: {
			candidateVsNoIndex: input.report.paired.candidateVsNoIndex,
			candidateVsAccepted: input.report.paired.candidateVsAccepted,
		},
		overall: {...overallVerdict, success: successOf(input.report)},
		classes,
		passed: blocking.length === 0,
		blocking,
	};
};

/**
 * Describes the hosted verdict in one bounded line.
 *
 * @param report - Release campaign record.
 * @returns A summary naming the claimed model, class verdicts, and every blocking finding.
 */
export const releaseCampaignSummaryOf = (report: ReleaseCampaignReportType): string => {
	const classes = report.classes
		.map((verdict) => {
			const ratio = verdict.target.medianRatio === null ? 'n/a' : verdict.target.medianRatio.toFixed(3);

			return `${verdict.class} ${verdict.targetMetric}=${ratio}`;
		})
		.join(', ');
	const blocking = report.blocking.length === 0 ? 'no blocking finding' : report.blocking.join('; ');

	return `claim ${report.claimClass} release-authority=yes; model ${report.hosted.reference}; classes ${classes}; ${blocking}`;
};
