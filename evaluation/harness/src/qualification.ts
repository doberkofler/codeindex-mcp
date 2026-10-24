import {assertAcceptedContractOf} from './economicContract.ts';
import {assertLocalClaimClass} from './localContract.ts';
import {hashOf} from './hash.ts';
import {EXECUTION_SCHEMA_VERSION, modelIdentityOf} from './identity.ts';
import {summarizeTreatment} from './report.ts';
import {isEvidenceRun, median, pairedMetricOf, pairsOf, successOf} from './reportMetrics.ts';
import {
	QUALIFICATION_CLAIM_CLASS,
	QUALIFICATION_CRITERIA,
	QUALIFICATION_EXECUTIONS,
	QUALIFICATION_FRONTIER_GATE,
	QUALIFICATION_RELEASE_AUTHORITY,
	QUALIFICATION_REPETITIONS,
	QUALIFICATION_SCHEMA_VERSION,
	QUALIFICATION_TREATMENT_IDS,
	qualificationBaselineOf,
	type QualificationCriterionType,
	type QualificationInputType,
	type QualificationReportType,
	type QualificationSlotType,
} from './qualificationContract.ts';
import {qualificationValidityOf} from './qualificationValidity.ts';
import {type RunResultType} from './runTypes.ts';
import {caseHashOf} from './schema.ts';

const slotKeyOf = (caseId: string, treatment: string, repetition: number): string => `${caseId}\u0000${treatment}\u0000${repetition}`;

const causeOf = (run: RunResultType): string | null => {
	if (isEvidenceRun(run)) {
		return null;
	}

	const causes = [run.outcome, ...run.defects, ...(run.invalidReason === null ? [] : [run.invalidReason])];

	return [...new Set(causes)].join('; ');
};

const slotsOf = (input: QualificationInputType): readonly QualificationSlotType[] => {
	const bySlot = new Map<string, RunResultType>();

	for (const run of input.results) {
		const key = slotKeyOf(run.caseId, run.treatment, run.repetition);

		if (bySlot.has(key)) {
			throw new Error(`qualification campaign contains duplicate slot ${run.caseId}/${run.treatment}/rep-${run.repetition}`);
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

const expectedSlots = (input: QualificationInputType): readonly Readonly<{caseId: string; treatment: string; repetition: number}>[] => {
	const planned = input.caseList.flatMap((testCase) =>
		QUALIFICATION_TREATMENT_IDS.flatMap((treatment) =>
			Array.from({length: QUALIFICATION_REPETITIONS}, (_, index) => ({
				caseId: testCase.id,
				treatment,
				repetition: index + 1,
			})),
		),
	);

	if (planned.length !== QUALIFICATION_EXECUTIONS) {
		throw new Error(`qualification plan must contain ${QUALIFICATION_EXECUTIONS} slots, derived ${planned.length}`);
	}

	return planned;
};

const assertDeclaredSlotsOf = (input: QualificationInputType, planned: readonly Readonly<{caseId: string; treatment: string; repetition: number}>[]): void => {
	const declared = input.expectedSlots.map((slot) => slotKeyOf(slot.caseId, slot.treatment, slot.repetition));
	const expected = planned.map((slot) => slotKeyOf(slot.caseId, slot.treatment, slot.repetition));

	if (declared.length !== expected.length || declared.some((key, index) => key !== expected[index])) {
		throw new Error(`qualification campaign declares a plan that differs from the fixed ${QUALIFICATION_EXECUTIONS}-slot plan`);
	}
};

const assertResultCaseOf = (input: QualificationInputType, run: RunResultType): void => {
	const testCase = input.caseList.find((item) => item.id === run.caseId);

	if (testCase === undefined) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} names an undeclared case`);
	}

	if (run.identity.case.id !== run.caseId || run.identity.case.hash !== caseHashOf(testCase) || run.identity.case.promptHash !== hashOf(testCase.prompt)) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with its pinned case content`);
	}

	if (run.revision !== input.subject.revision || run.identity.subject.revision !== input.subject.revision) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with the pinned subject revision`);
	}

	if (run.identity.repetitionIndex !== run.repetition) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with its repetition identity`);
	}
};

const assertResultTreatmentOf = (input: QualificationInputType, run: RunResultType): void => {
	if (!(QUALIFICATION_TREATMENT_IDS as readonly string[]).includes(run.treatment)) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} uses an undeclared treatment`);
	}

	if (run.identity.treatment.id !== run.treatment) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with its treatment identity`);
	}

	if (run.treatment === 'no-index' && run.artifacts.loaded !== null) {
		throw new Error(`qualification no-index result ${run.caseId}/rep-${run.repetition} loaded an artifact`);
	}

	if (run.treatment === 'canonical') {
		const {loaded} = run.artifacts;

		if (loaded === null || loaded.id !== input.stagedCanonical.id || loaded.digest !== input.stagedCanonical.digest) {
			throw new Error(
				`qualification canonical result ${run.caseId}/rep-${run.repetition} loaded ${loaded === null ? 'no artifact' : `${loaded.id}@${loaded.digest}`}, expected ${input.stagedCanonical.id}@${input.stagedCanonical.digest}`,
			);
		}
	}
};

const assertResultIdentityOf = (input: QualificationInputType, run: RunResultType): void => {
	const expectedModel = modelIdentityOf(input.environment.model.reference, input.environment);
	const modelFields = ['provider', 'modelId', 'digest', 'quantization', 'runtime', 'runtimeVersion', 'generationSettingsDigest'] as const;

	for (const field of modelFields) {
		if (run.identity.model[field] !== expectedModel[field]) {
			throw new Error(
				`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} model.${field} is "${run.identity.model[field]}", expected "${expectedModel[field]}"`,
			);
		}
	}

	if (run.identity.suite.id !== input.suite.id || run.identity.suite.version !== input.suite.version || run.identity.suite.hash !== input.suite.hash) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with the campaign suite identity`);
	}

	if (run.identity.subject.contentManifestHash !== input.subject.contentManifestHash) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} disagrees with the pinned subject content`);
	}

	if (run.identity.harness.version !== input.harnessVersion) {
		throw new Error(
			`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} was produced by harness ${run.identity.harness.version}, expected ${input.harnessVersion}`,
		);
	}

	if (run.campaignId !== input.campaignId) {
		throw new Error(`qualification result ${run.caseId}/${run.treatment}/rep-${run.repetition} belongs to campaign "${run.campaignId}"`);
	}
};

const assertIdentityOf = (input: QualificationInputType, planned: readonly Readonly<{caseId: string; treatment: string; repetition: number}>[]): void => {
	assertLocalClaimClass(input.claimClass);
	assertDeclaredSlotsOf(input, planned);

	if (input.stagedCanonical.id !== input.canonical.id || input.stagedCanonical.digest !== input.canonical.digest) {
		throw new Error(
			`staged canonical artifact ${input.stagedCanonical.id}@${input.stagedCanonical.digest} differs from the pinned ${input.canonical.id}@${input.canonical.digest}`,
		);
	}

	for (const run of input.results) {
		assertResultCaseOf(input, run);
		assertResultTreatmentOf(input, run);
		assertResultIdentityOf(input, run);
	}
};

const planShapeOf = (input: QualificationInputType): QualificationReportType['plan'] => {
	const caseCount = new Set(input.results.map((run) => run.caseId)).size;
	const treatmentIds = [...new Set(input.results.map((run) => run.treatment))].sort();
	const repetitions = input.results.length === 0 ? 0 : Math.max(...input.results.map((run) => run.repetition));
	const executions = input.results.length;
	const complete =
		executions === QUALIFICATION_EXECUTIONS &&
		caseCount === input.caseList.length &&
		treatmentIds.join(',') === [...QUALIFICATION_TREATMENT_IDS].sort().join(',') &&
		repetitions === QUALIFICATION_REPETITIONS;
	const validExecutions = input.results.filter((run) => isEvidenceRun(run)).length;

	return {
		caseCount,
		treatments: treatmentIds,
		repetitions,
		expectedExecutions: QUALIFICATION_EXECUTIONS,
		executions,
		validExecutions,
		invalidExecutions: executions - validExecutions,
		missingExecutions: complete ? 0 : Math.max(0, QUALIFICATION_EXECUTIONS - executions),
	};
};

const structuralReasonsOf = (
	input: QualificationInputType,
	plan: QualificationReportType['plan'],
	slots: readonly QualificationSlotType[],
): readonly string[] => [
	...(plan.executions === QUALIFICATION_EXECUTIONS && plan.caseCount === input.caseList.length && plan.validExecutions === QUALIFICATION_EXECUTIONS
		? []
		: [
				`planned ${QUALIFICATION_EXECUTIONS} valid slots; found ${plan.executions} execution(s), ${plan.validExecutions} valid, ${plan.invalidExecutions} invalid, ${plan.missingExecutions} missing`,
			]),
	...slots.filter((slot) => slot.status === 'invalid').map((slot) => `${slot.caseId}/${slot.treatment}/rep-${slot.repetition}: ${slot.cause ?? 'invalid'}`),
];

const caseSuccessOf = (results: readonly RunResultType[], caseId: string, treatment: string): number =>
	successOf(results.filter((run) => run.caseId === caseId && run.treatment === treatment && isEvidenceRun(run)));

const correctnessChecksOf = (
	input: QualificationInputType,
	plan: QualificationReportType['plan'],
	canonical: ReturnType<typeof summarizeTreatment>,
): readonly QualificationCriterionType[] => {
	const lossyCases = input.caseList.filter(
		(testCase) => caseSuccessOf(input.results, testCase.id, 'canonical') < caseSuccessOf(input.results, testCase.id, 'no-index'),
	);

	return [
		{
			id: 'correctness.minimum-canonical-success',
			kind: 'correctness',
			passed: canonical.successRate >= QUALIFICATION_CRITERIA.correctness.minimumCanonicalSuccessRate,
			expected: `>= ${QUALIFICATION_CRITERIA.correctness.minimumCanonicalSuccessRate}`,
			observed: `${(canonical.successRate * 100).toFixed(1)}% (n=${canonical.validRuns})`,
		},
		{
			id: 'correctness.no-case-loss-vs-no-index',
			kind: 'correctness',
			passed: lossyCases.length <= QUALIFICATION_CRITERIA.correctness.maximumCaseSuccessLossVsNoIndex,
			expected: `<= ${QUALIFICATION_CRITERIA.correctness.maximumCaseSuccessLossVsNoIndex} case(s) below no-index`,
			observed: lossyCases.length === 0 ? 'no case below no-index' : `${lossyCases.length} case(s): ${lossyCases.map((testCase) => testCase.id).join(', ')}`,
		},
		{
			id: 'correctness.complete-slot-plan',
			kind: 'correctness',
			passed: plan.executions === QUALIFICATION_EXECUTIONS && plan.validExecutions === QUALIFICATION_EXECUTIONS,
			expected: `${QUALIFICATION_EXECUTIONS} valid executions`,
			observed: `${plan.validExecutions}/${QUALIFICATION_EXECUTIONS}`,
		},
	];
};

const timeoutChecksOf = (results: readonly RunResultType[]): readonly QualificationCriterionType[] => {
	const timedOut = results.filter((run) => run.outcome === 'timed-out').length;
	const aborted = results.filter((run) => run.outcome === 'aborted').length;

	return [
		{
			id: 'timeout.no-timed-out-execution',
			kind: 'timeout',
			passed: timedOut <= QUALIFICATION_CRITERIA.timeout.maximumTimedOutExecutions,
			expected: `<= ${QUALIFICATION_CRITERIA.timeout.maximumTimedOutExecutions}`,
			observed: String(timedOut),
		},
		{
			id: 'timeout.no-aborted-execution',
			kind: 'timeout',
			passed: aborted <= QUALIFICATION_CRITERIA.timeout.maximumAbortedExecutions,
			expected: `<= ${QUALIFICATION_CRITERIA.timeout.maximumAbortedExecutions}`,
			observed: String(aborted),
		},
	];
};

const toolUseChecksOf = (results: readonly RunResultType[]): readonly QualificationCriterionType[] => {
	const executeCalls = results.reduce((total, run) => total + run.routing.executeCalls, 0);
	const unknownToolCalls = results.reduce((total, run) => total + run.routing.unknownTools.length, 0);
	const indexedCanonicalRuns = results.filter((run) => run.treatment === 'canonical' && isEvidenceRun(run) && run.indexCalls > 0).length;

	return [
		{
			id: 'tool-use.no-generic-execute',
			kind: 'tool-use',
			passed: executeCalls <= QUALIFICATION_CRITERIA.toolUse.maximumExecuteCalls,
			expected: `<= ${QUALIFICATION_CRITERIA.toolUse.maximumExecuteCalls}`,
			observed: String(executeCalls),
		},
		{
			id: 'tool-use.only-captured-tools',
			kind: 'tool-use',
			passed: unknownToolCalls <= QUALIFICATION_CRITERIA.toolUse.maximumUnknownToolCalls,
			expected: `<= ${QUALIFICATION_CRITERIA.toolUse.maximumUnknownToolCalls}`,
			observed: String(unknownToolCalls),
		},
		{
			id: 'tool-use.canonical-artifact-exercised',
			kind: 'tool-use',
			passed: indexedCanonicalRuns >= QUALIFICATION_CRITERIA.toolUse.minimumIndexedCanonicalRuns,
			expected: `>= ${QUALIFICATION_CRITERIA.toolUse.minimumIndexedCanonicalRuns}`,
			observed: String(indexedCanonicalRuns),
		},
	];
};

const efficiencyChecksOf = (metrics: QualificationReportType['efficiency']['metrics']): readonly QualificationCriterionType[] => {
	const bytes = metrics[QUALIFICATION_CRITERIA.efficiency.targetMetric];
	const calls = metrics.toolCalls;

	return [
		{
			id: 'efficiency.target-metric-not-worse',
			kind: 'efficiency',
			passed: bytes.medianRatio !== null && bytes.medianRatio <= QUALIFICATION_CRITERIA.efficiency.maximumMedianRatioVsNoIndex,
			expected: `${QUALIFICATION_CRITERIA.efficiency.targetMetric} ratio <= ${QUALIFICATION_CRITERIA.efficiency.maximumMedianRatioVsNoIndex}`,
			observed: bytes.medianRatio === null ? 'unavailable' : bytes.medianRatio.toFixed(3),
		},
		{
			id: 'efficiency.tool-calls-not-worse',
			kind: 'efficiency',
			passed: calls.medianRatio !== null && calls.medianRatio <= QUALIFICATION_CRITERIA.efficiency.maximumToolCallsRatioVsNoIndex,
			expected: `toolCalls ratio <= ${QUALIFICATION_CRITERIA.efficiency.maximumToolCallsRatioVsNoIndex}`,
			observed: calls.medianRatio === null ? 'unavailable' : calls.medianRatio.toFixed(3),
		},
		{
			id: 'efficiency.complete-case-pairs',
			kind: 'efficiency',
			passed: bytes.pairCount >= QUALIFICATION_CRITERIA.efficiency.minimumPairedCaseCount,
			expected: `>= ${QUALIFICATION_CRITERIA.efficiency.minimumPairedCaseCount} paired case(s)`,
			observed: String(bytes.pairCount),
		},
	];
};

const efficiencyOf = (results: readonly RunResultType[], seed: string): QualificationReportType['efficiency'] => {
	const metrics = {
		retrievalBytes: pairedMetricOf(results, {baseline: 'no-index', treatment: 'canonical', metric: 'retrievalBytes', seed}),
		toolCalls: pairedMetricOf(results, {baseline: 'no-index', treatment: 'canonical', metric: 'toolCalls', seed}),
		tokens: pairedMetricOf(results, {baseline: 'no-index', treatment: 'canonical', metric: 'tokens', seed}),
		wallTimeMs: pairedMetricOf(results, {baseline: 'no-index', treatment: 'canonical', metric: 'wallTimeMs', seed}),
	} as const;
	const pairs = pairsOf(results, 'no-index', 'canonical', 'retrievalBytes').map((pair) => ({
		caseId: pair.caseId,
		noIndexBytes: median(pair.baseline),
		canonicalBytes: median(pair.treatment),
	}));

	return {targetMetric: QUALIFICATION_CRITERIA.efficiency.targetMetric, pairs, metrics};
};

/**
 * Builds the sanitized independent local-model qualification record.
 *
 * The record describes only the pinned local model against the fixed canonical
 * artifact. It fails closed on any identity mismatch, carries no release
 * authority, and records qualification and disqualification reasons separately
 * from the product-release gate.
 *
 * @param input - Campaign identity, pinned inputs, planned slots, and results.
 * @returns The qualification record.
 */
export const qualificationReportOf = (input: QualificationInputType): QualificationReportType => {
	const planned = expectedSlots(input);

	assertAcceptedContractOf(input.contract);
	assertIdentityOf(input, planned);

	const slots = slotsOf(input);
	const plan = planShapeOf(input);
	const noIndex = summarizeTreatment(input.results.filter((run) => run.treatment === 'no-index'));
	const canonical = summarizeTreatment(input.results.filter((run) => run.treatment === 'canonical'));
	const seed = hashOf({campaignId: input.campaignId, canonical: input.canonical.digest, plan: QUALIFICATION_EXECUTIONS});
	const efficiency = efficiencyOf(input.results, seed);
	const validity = qualificationValidityOf({
		contract: input.contract,
		preflight: input.preflight,
		stateRootOutsideCheckout: input.stateRootOutsideCheckout,
		plan,
		results: input.results,
	});
	const checks = [
		...validity.checks,
		...correctnessChecksOf(input, plan, canonical),
		...timeoutChecksOf(input.results),
		...toolUseChecksOf(input.results),
		...efficiencyChecksOf(efficiency.metrics),
	];
	const structural = structuralReasonsOf(input, plan, slots);
	const failedChecks = checks.filter((check) => !check.passed);
	const status = structural.length === 0 && failedChecks.length === 0 ? 'qualified' : 'disqualified';
	const disqualificationReasons = [...structural, ...failedChecks.map((check) => `${check.id}: expected ${check.expected}, observed ${check.observed}`)];
	const model = modelIdentityOf(input.environment.model.reference, input.environment);

	return {
		recordType: 'local-model-qualification',
		schemaVersion: QUALIFICATION_SCHEMA_VERSION,
		claimClass: QUALIFICATION_CLAIM_CLASS,
		releaseAuthority: QUALIFICATION_RELEASE_AUTHORITY,
		frontierReleaseGate: QUALIFICATION_FRONTIER_GATE,
		status,
		model,
		environment: {id: input.environment.id, hash: hashOf(input.environment)},
		harness: {version: input.harnessVersion, schemaVersion: EXECUTION_SCHEMA_VERSION},
		suite: input.suite,
		subject: input.subject,
		contract: input.contract,
		baseline: qualificationBaselineOf({
			suite: input.loadedSuite,
			cases: input.caseList,
			canonical: input.canonical,
			harnessVersion: input.harnessVersion,
		}),
		canonical: {
			id: input.canonical.id,
			version: input.canonical.version,
			digest: input.canonical.digest,
			root: input.canonical.root,
			entryPoint: input.canonical.entryPoint,
			manifestHash: hashOf(input.canonical),
		},
		criteria: QUALIFICATION_CRITERIA,
		validity,
		checks,
		plan,
		slots,
		treatments: {noIndex, canonical},
		efficiency,
		report: {
			campaignId: input.campaignId,
			identityDigests: [...new Set(input.results.map((run) => run.identityDigest))].sort(),
		},
		qualification: {
			status,
			reasons: status === 'qualified' ? [`all ${QUALIFICATION_EXECUTIONS} slots valid`, `${checks.length}/${checks.length} predeclared criteria passed`] : [],
		},
		disqualification: {reasons: status === 'qualified' ? [] : disqualificationReasons},
		productRelease: {
			claimClass: QUALIFICATION_CLAIM_CLASS,
			releaseAuthority: QUALIFICATION_RELEASE_AUTHORITY,
			frontierGate: QUALIFICATION_FRONTIER_GATE,
			note: 'local-model qualification neither satisfies nor blocks the frontier architecture/release gate',
		},
	};
};

/**
 * Describes the qualification verdict in one bounded line.
 *
 * @param report - Qualification record.
 * @returns A summary naming the claim class, model, and every disqualification reason.
 */
export const qualificationSummaryOf = (report: QualificationReportType): string => {
	const reasons = report.disqualification.reasons.length === 0 ? 'all criteria passed' : report.disqualification.reasons.join('; ');

	return `claim ${report.claimClass} release-authority=no frontier-gate=${report.frontierReleaseGate}; model ${report.model.modelId}; ${report.status}; ${reasons}`;
};
