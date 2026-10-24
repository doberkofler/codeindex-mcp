import {type ContractPinType} from './economicContract.ts';
import {
	QUALIFICATION_EXECUTIONS,
	QUALIFICATION_TREATMENT_IDS,
	QUALIFICATION_VALIDITY_CRITERIA,
	type QualificationCriterionType,
	type QualificationPreflightType,
	type QualificationReportType,
	type QualificationValidityType,
} from './qualificationContract.ts';
import {surfaceRequestLedgerOf} from './requestSurface.ts';
import {type RunResultType} from './runTypes.ts';

const meteringEvidenceOf = (results: readonly RunResultType[]): QualificationValidityType['metering'] => {
	let requests = 0;
	let unsettledRequests = 0;
	let failedRequests = 0;
	let exactRuns = 0;

	for (const run of results) {
		const meter = run.providerMeter;

		if (meter === null || meter === undefined) {
			continue;
		}

		requests += meter.requestCount;
		unsettledRequests += meter.pendingCount;
		failedRequests += meter.failedCount;

		if (
			meter.settledExactlyOnce &&
			meter.ordinalsContiguous &&
			meter.pendingCount === 0 &&
			meter.failedCount === 0 &&
			meter.pathClean &&
			meter.total.state === 'exact'
		) {
			exactRuns += 1;
		}
	}

	return {runs: results.length, exactRuns, requests, unsettledRequests, failedRequests};
};

const requestOneEvidenceOf = (results: readonly RunResultType[]): QualificationValidityType['requestOne'] => ({
	runs: results.length,
	exactRuns: results.filter(
		(run) => run.providerMeter !== null && run.providerMeter !== undefined && surfaceRequestLedgerOf(run.surface, run.providerMeter.requests).result === 'pass',
	).length,
});

const corpusEvidenceOf = (preflight: QualificationPreflightType): QualificationValidityType['corpus'] => {
	const probes = preflight.cases.flatMap((item) => (item.symbolProbe === null ? [] : [item.symbolProbe]));

	return {
		result: preflight.result,
		cases: preflight.cases.length,
		casesWithPaths: preflight.cases.filter((item) => item.pathsPresent).length,
		symbolProbes: probes.length,
		symbolProbesOk: probes.filter((probe) => probe.ok).length,
		missingPaths: preflight.treatments.reduce((total, item) => total + item.missingPaths.length, 0),
		unindexedPaths: preflight.treatments.reduce((total, item) => total + item.unindexedPaths.length, 0),
		failures: preflight.failures,
	};
};

const isolationEvidenceOf = (results: readonly RunResultType[], stateRootOutsideCheckout: boolean): QualificationValidityType['isolation'] => ({
	runs: results.length,
	cleanRuns: results.filter((run) => (run.externalPathAttemptCount ?? 0) === 0 && (run.providerMeter?.pathDisclosureCount ?? 0) === 0).length,
	restoredRuns: results.filter((run) => run.isolation.checkoutClean && run.isolation.revisionMatch && run.isolation.restored).length,
	stateRootOutsideCheckout,
	externalPathAttempts: results.reduce((total, run) => total + (run.externalPathAttemptCount ?? 0), 0),
	pathDisclosures: results.reduce((total, run) => total + (run.providerMeter?.pathDisclosureCount ?? 0), 0),
});

const validityChecksOf = (
	validity: Omit<QualificationValidityType, 'checks' | 'contract'>,
	plan: QualificationReportType['plan'],
): readonly QualificationCriterionType[] => {
	const corpusPassed =
		validity.corpus.result === 'pass' &&
		validity.corpus.casesWithPaths === validity.corpus.cases &&
		validity.corpus.symbolProbesOk === validity.corpus.symbolProbes &&
		validity.corpus.missingPaths === 0 &&
		validity.corpus.unindexedPaths === 0;

	return [
		{
			id: 'validity.request-metering',
			kind: 'validity',
			passed:
				validity.metering.exactRuns === validity.metering.runs &&
				validity.metering.unsettledRequests <= QUALIFICATION_VALIDITY_CRITERIA.metering.maximumUnsettledRequests &&
				validity.metering.failedRequests <= QUALIFICATION_VALIDITY_CRITERIA.metering.maximumFailedRequests,
			expected: `${validity.metering.runs} exact request ledger(s)`,
			observed: `${validity.metering.exactRuns}/${validity.metering.runs} exact, ${validity.metering.requests} request(s), ${validity.metering.unsettledRequests} unsettled, ${validity.metering.failedRequests} failed`,
		},
		{
			id: 'validity.request-1-surface',
			kind: 'validity',
			passed: validity.requestOne.exactRuns === validity.requestOne.runs,
			expected: `${validity.requestOne.runs} exact request-1 surface(s)`,
			observed: `${validity.requestOne.exactRuns}/${validity.requestOne.runs} exact`,
		},
		{
			id: 'validity.corpus-coverage',
			kind: 'validity',
			passed: corpusPassed && validity.corpus.failures.length === 0,
			expected: `complete corpus preflight; semantic symbol probes required=${String(QUALIFICATION_VALIDITY_CRITERIA.corpus.requireSemanticSymbolProbes)}`,
			observed: `${validity.corpus.result}; ${validity.corpus.casesWithPaths}/${validity.corpus.cases} case path set(s), ${validity.corpus.symbolProbesOk}/${validity.corpus.symbolProbes} symbol probe(s), ${validity.corpus.missingPaths} missing path(s), ${validity.corpus.unindexedPaths} unindexed path(s)`,
		},
		{
			id: 'validity.workspace-isolation',
			kind: 'validity',
			passed:
				validity.isolation.cleanRuns === validity.isolation.runs &&
				validity.isolation.restoredRuns === validity.isolation.runs &&
				validity.isolation.stateRootOutsideCheckout,
			expected: `${validity.isolation.runs} isolated and restored execution(s) with state outside the checkout`,
			observed: `${validity.isolation.cleanRuns}/${validity.isolation.runs} clean, ${validity.isolation.restoredRuns}/${validity.isolation.runs} restored, state-outside-checkout=${String(validity.isolation.stateRootOutsideCheckout)}, ${validity.isolation.externalPathAttempts} external attempt(s), ${validity.isolation.pathDisclosures} path disclosure(s)`,
		},
		{
			id: 'validity.all-valid-run-aggregation',
			kind: 'validity',
			passed:
				plan.treatments.length === QUALIFICATION_TREATMENT_IDS.length &&
				plan.executions === QUALIFICATION_EXECUTIONS &&
				plan.validExecutions === QUALIFICATION_EXECUTIONS,
			expected: `${QUALIFICATION_EXECUTIONS} valid execution(s) aggregated across both treatments, including incorrect valid answers`,
			observed: `${plan.validExecutions}/${plan.executions} valid execution(s), ${plan.treatments.length} treatment(s)`,
		},
	];
};

/**
 * Derives the validity-v2 evidence and gates for one qualification campaign.
 *
 * The gates fail closed on incomplete metering, a request-1 mismatch,
 * incomplete corpus coverage, contaminated or unrestored isolation, or a plan
 * that does not aggregate all valid executions.
 *
 * @param input - Contract pin, preflight, isolation fact, plan, and results.
 * @returns Validity evidence plus its deterministic checks.
 */
export const qualificationValidityOf = (
	input: Readonly<{
		contract: ContractPinType;
		preflight: QualificationPreflightType;
		stateRootOutsideCheckout: boolean;
		plan: QualificationReportType['plan'];
		results: readonly RunResultType[];
	}>,
): QualificationValidityType => {
	const evidence = {
		metering: meteringEvidenceOf(input.results),
		requestOne: requestOneEvidenceOf(input.results),
		corpus: corpusEvidenceOf(input.preflight),
		isolation: isolationEvidenceOf(input.results, input.stateRootOutsideCheckout),
	};

	return {
		contract: input.contract,
		...evidence,
		checks: validityChecksOf(evidence, input.plan),
	};
};
