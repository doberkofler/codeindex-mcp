import {economicAnalysisOf} from './economicAnalysis.ts';
import {type ContractPinType, assertAcceptedContractOf, EVALUATION_CONTRACT} from './economicContract.ts';
import {economicExecutionsOf} from './costStudy.ts';
import {hashOf} from './hash.ts';
import {executionCampaignDigestOf, executionCaseComparisonDigestOf} from './identity.ts';
import {
	allToolOutputBytesOf,
	caseDeltasOf,
	isEvidenceRun,
	pairedComparisonOf,
	retrievalBytesOf,
	sampleStatisticsOf,
	successOf,
	thresholdsOf,
	tokenStateOf,
	tokensOf,
} from './reportMetrics.ts';
import {
	type AnalysisType,
	type ClassReportType,
	type MetricStateType,
	REPORT_CLASSES,
	REPORT_RECORD_TYPE,
	REPORT_SCHEMA_VERSION,
	type ReportMetadataType,
	type ReportType,
	type RunValueType,
	type TreatmentStatisticsType,
	type TreatmentSummaryType,
} from './reportTypes.ts';
import {type RunResultType} from './runTypes.ts';
import {TREATMENT_IDS} from './treatment.ts';

export * from './reportTypes.ts';
export {type PairedMetricNameType} from './reportMetrics.ts';

const runsOf = (runs: readonly RunResultType[], treatment: string): readonly RunResultType[] => runs.filter((run) => run.treatment === treatment);

/**
 * Summarizes one treatment's valid runs.
 *
 * @param runs - Results for the treatment.
 * @returns Aggregate metrics with explicit sample counts.
 */
export const summarizeTreatment = (runs: readonly RunResultType[]): TreatmentSummaryType => {
	const valid = runs.filter((run) => isEvidenceRun(run));
	const truthful = valid.filter((run) => run.grade.falseAbsence || run.grade.success);
	const tokenValues = valid.map((run) => tokensOf(run)).filter((value): value is number => value !== null);
	const tokenComplete = valid.length > 0 && valid.every((run) => tokensOf(run) !== null);
	const tokenState: MetricStateType =
		tokenValues.length > 0 ? 'exact' : valid.length > 0 && valid.every((run) => tokenStateOf(run) === 'not-applicable') ? 'not-applicable' : 'unavailable';
	const statistics: TreatmentStatisticsType = {
		outputBytes: sampleStatisticsOf(valid.map((run) => run.outputBytes)),
		allToolOutputBytes: sampleStatisticsOf(valid.map((run) => allToolOutputBytesOf(run))),
		retrievalBytes: sampleStatisticsOf(valid.map((run) => retrievalBytesOf(run))),
		toolCalls: sampleStatisticsOf(valid.map((run) => run.toolCalls.length)),
		wallTimeMs: sampleStatisticsOf(valid.map((run) => run.durationMs)),
		tokens: {
			...sampleStatisticsOf(tokenValues),
			state: tokenState,
			complete: tokenComplete,
		},
	};

	return {
		runs: runs.length,
		validRuns: valid.length,
		successRate: successOf(valid),
		falseAbsenceRate: truthful.length === 0 ? 0 : valid.filter((run) => run.grade.falseAbsence).length / truthful.length,
		medianOutputBytes: statistics.outputBytes.median,
		medianToolCalls: statistics.toolCalls.median,
		medianTokens: statistics.tokens.median,
		p95WallMs: statistics.wallTimeMs.p95,
		indexUsageRate: valid.length === 0 ? 0 : valid.filter((run) => run.indexCalls > 0).length / valid.length,
		executeRuns: valid.filter((run) => run.routing.executeCalls > 0).length,
		unknownToolRuns: valid.filter((run) => run.routing.unknownTools.length > 0).length,
		invalidRuns: runs.length - valid.length,
		retriedRuns: runs.filter((run) => run.attempts.length > 1).length,
		statistics,
	};
};

const analysisOf = (runs: readonly RunResultType[], seed: string): AnalysisType => {
	const noIndex = summarizeTreatment(runsOf(runs, 'no-index'));
	const accepted = summarizeTreatment(runsOf(runs, 'accepted'));
	const candidate = summarizeTreatment(runsOf(runs, 'candidate'));
	const caseDeltas = caseDeltasOf(runs);
	const thresholds = thresholdsOf({noIndex, accepted, candidate, caseDeltas});
	const paired = {
		candidateVsNoIndex: pairedComparisonOf(runs, 'no-index', 'candidate', seed),
		candidateVsAccepted: pairedComparisonOf(runs, 'accepted', 'candidate', seed),
		acceptedVsNoIndex: pairedComparisonOf(runs, 'no-index', 'accepted', seed),
	};

	return {
		noIndex,
		accepted,
		candidate,
		caseDeltas,
		paired,
		thresholds,
		passed: thresholds.every((threshold) => threshold.passed),
	};
};

/** Comparable keys of one stored result. */
type RunKeysType = Readonly<{
	slot: string;
	campaignDigest: string;
	caseDigest: string;
	treatmentDigest: string;
}>;

/**
 * Validates one result and returns the keys it is compared by.
 *
 * @param run - Stored result.
 * @returns Slot, campaign, case, and per-treatment configuration digests.
 */
const runKeysOf = (run: RunResultType): RunKeysType => {
	if (!(TREATMENT_IDS as readonly string[]).includes(run.treatment)) {
		throw new Error(`result ${run.caseId}/${run.treatment} has an undeclared treatment; pooled index-usage groups are not comparable`);
	}

	if (!(REPORT_CLASSES as readonly string[]).includes(run.caseClass)) {
		throw new Error(`result ${run.caseId} has unknown case class "${run.caseClass}"`);
	}

	if (run.identity.case.id !== run.caseId || run.identity.treatment.id !== run.treatment || run.identity.repetitionIndex !== run.repetition) {
		throw new Error(`result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with its execution identity`);
	}

	return {
		slot: `${run.caseId}/${run.treatment}/${run.repetition}`,
		campaignDigest: executionCampaignDigestOf(run.identity),
		caseDigest: executionCaseComparisonDigestOf(run.identity),
		treatmentDigest: hashOf({
			agent: {toolListHash: run.identity.agent.toolListHash, permissionsHash: run.identity.agent.permissionsHash},
			codeIndex: run.identity.codeIndex,
		}),
	};
};

/**
 * Rejects results that cannot share one campaign or one paired case.
 *
 * The only grouping used by a report is the declared treatment. Results with an
 * undeclared treatment, a duplicate slot, or a different campaign identity are
 * rejected instead of pooled, so a caller cannot manufacture a
 * used-versus-not-used comparison from mixed results. Tool and CodeIndex
 * configuration may differ between treatments by design, but must stay identical
 * within one treatment.
 *
 * @param runs - Results proposed for one report.
 */
export const assertComparableRuns = (runs: readonly RunResultType[]): void => {
	if (runs.length === 0) {
		throw new Error('a report requires at least one result');
	}

	const campaignDigests = new Set<string>();
	const caseDigests = new Map<string, string>();
	const slots = new Set<string>();
	const campaignIds = new Set<string>();
	const treatmentDigests = new Map<string, string>();

	for (const run of runs) {
		const keys = runKeysOf(run);

		if (slots.has(keys.slot)) {
			throw new Error(`results contain duplicate slot ${keys.slot}`);
		}

		slots.add(keys.slot);
		campaignIds.add(run.campaignId);

		const existingTreatmentDigest = treatmentDigests.get(run.treatment);

		if (existingTreatmentDigest !== undefined && existingTreatmentDigest !== keys.treatmentDigest) {
			throw new Error(`results for treatment ${run.treatment} disagree on tool or CodeIndex configuration`);
		}

		treatmentDigests.set(run.treatment, keys.treatmentDigest);

		if (campaignDigests.size > 0 && !campaignDigests.has(keys.campaignDigest)) {
			throw new Error('results have incompatible campaign identities; model, subject, agent, artifact, or configuration differs');
		}

		campaignDigests.add(keys.campaignDigest);

		const existingCaseDigest = caseDigests.get(run.caseId);

		if (existingCaseDigest !== undefined && existingCaseDigest !== keys.caseDigest) {
			throw new Error(`results for case ${run.caseId} have incompatible comparison identities`);
		}

		caseDigests.set(run.caseId, keys.caseDigest);
	}

	if (campaignIds.size !== 1) {
		throw new Error('results come from different campaigns and cannot be merged');
	}

	if (campaignDigests.size !== 1) {
		throw new Error('results have incompatible campaign identities; model, subject, agent, artifact, or configuration differs');
	}
};

const metadataOf = (runs: readonly RunResultType[], metadata: ReportMetadataType | undefined): ReportMetadataType => {
	if (metadata !== undefined) {
		return {...metadata, contract: metadata.contract ?? null};
	}

	const [first] = runs;

	if (first === undefined) {
		throw new Error('a report requires at least one result');
	}

	return {
		campaignId: first.campaignId,
		schemaVersion: first.schemaVersion,
		suite: {id: first.identity.suite.id, version: first.identity.suite.version, hash: first.identity.suite.hash, status: 'unknown'},
		components: {harnessVersion: first.identity.harness.version},
		claimClass: 'none',
		contract: first.identity.contract ?? null,
	};
};

const runValuesOf = (runs: readonly RunResultType[]): readonly RunValueType[] =>
	[...runs]
		.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.treatment.localeCompare(right.treatment) || left.repetition - right.repetition)
		.map((run) => ({
			identityDigest: run.identityDigest,
			attempt: run.attempt,
			caseId: run.caseId,
			caseClass: run.caseClass,
			treatment: run.treatment,
			repetition: run.repetition,
			outcome: run.outcome,
			evidence: isEvidenceRun(run),
			correctness: run.grade.result,
			workflow: run.workflow.result,
			postRun: run.postRun?.result ?? null,
			outputBytes: run.outputBytes,
			retrievalBytes: retrievalBytesOf(run),
			allToolOutputBytes: allToolOutputBytesOf(run),
			toolCalls: run.toolCalls.length,
			indexCalls: run.indexCalls,
			wallTimeMs: run.durationMs,
			tokens: {value: tokensOf(run), state: tokenStateOf(run)},
		}));

const caseDigestsOf = (runs: readonly RunResultType[]): readonly Readonly<{caseId: string; digest: string}>[] =>
	[...new Set(runs.map((run) => run.caseId))].sort().flatMap((caseId) => {
		const run = runs.find((candidate) => candidate.caseId === caseId);

		return run === undefined ? [] : [{caseId, digest: executionCaseComparisonDigestOf(run.identity)}];
	});

const assertContractRunsOf = (runs: readonly RunResultType[], contract: ContractPinType): void => {
	assertAcceptedContractOf(contract);

	for (const run of runs) {
		const pin = run.identity.contract;

		if (pin === undefined || pin.digest !== contract.digest || pin.id !== contract.id || pin.version !== contract.version) {
			throw new Error(
				`result ${run.caseId}/${run.treatment}/rep-${run.repetition} is not bound to the campaign contract; pre-v2 and v2 executions cannot share one report`,
			);
		}
	}
};

/**
 * Builds the complete paired report.
 *
 * Every number follows from the supplied results, and every percentile carries
 * its sample count. Bootstrap intervals use a fixed seed derived from the
 * campaign and metric, so recomputing the report yields the same interval.
 *
 * @param runs - Complete, effectively valid results for one campaign.
 * @param metadata - Declared campaign facts; derived from the results when omitted.
 * @returns The report.
 */
export const compare = (runs: readonly RunResultType[], metadata?: ReportMetadataType): ReportType => {
	assertComparableRuns(runs);

	const [first] = runs;

	if (first === undefined) {
		throw new Error('a report requires at least one result');
	}

	const campaign = metadataOf(runs, metadata);
	const contract = campaign.contract ?? null;

	if (contract !== null) {
		assertContractRunsOf(runs, contract);
	}

	const identityDigests = [...new Set(runs.map((run) => run.identityDigest))].sort();
	const schemaVersions = [...new Set(runs.map((run) => run.schemaVersion))].sort();
	const comparisonDigest = hashOf({
		campaign: executionCampaignDigestOf(first.identity),
		cases: caseDigestsOf(runs),
	});
	const seed = hashOf({campaignId: campaign.campaignId, suite: campaign.suite, comparisonDigest});
	const baseAnalysis = analysisOf(runs, seed);
	const economic = contract === null ? null : economicAnalysisOf(economicExecutionsOf(runs), EVALUATION_CONTRACT, seed);
	const analysis =
		economic === null
			? baseAnalysis
			: {
					...baseAnalysis,
					thresholds: economic.thresholds,
					passed: economic.passed,
				};
	const classes = REPORT_CLASSES.map((caseClass): ClassReportType => {
		const classRuns = runs.filter((run) => run.caseClass === caseClass);
		const classAnalysis = analysisOf(classRuns, hashOf({seed, caseClass}));

		return {...classAnalysis, class: caseClass, caseIds: [...new Set(classRuns.map((run) => run.caseId))].sort()};
	}).filter((report) => report.caseIds.length > 0);

	return {
		recordType: REPORT_RECORD_TYPE,
		schemaVersion: REPORT_SCHEMA_VERSION,
		campaign,
		sources: {
			identityDigests,
			schemaVersions,
			resultCount: runs.length,
			comparisonDigest,
		},
		runs: runValuesOf(runs),
		...analysis,
		classes,
		economic,
	};
};
