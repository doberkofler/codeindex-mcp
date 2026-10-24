import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {QUALIFICATION_EXECUTIONS, QUALIFICATION_REPETITIONS} from './qualificationContract.ts';
import {qualificationReportOf} from './qualification.ts';
import {inputOf, loaded, preflightOf, resultsOf} from './qualificationTestSupport.ts';

describe('qualification validity-v2 controls', () => {
	it('fails closed when request metering or the request-1 surface is not exact', () => {
		const unmetered = qualificationReportOf(inputOf(resultsOf({metering: 'none'})));

		assert.equal(unmetered.status, 'disqualified');
		assert.equal(unmetered.validity.metering.exactRuns, 0);
		assert.match(unmetered.disqualification.reasons.join('; '), /validity\.request-metering/u);

		const pending = qualificationReportOf(inputOf(resultsOf({metering: 'pending'})));

		assert.equal(pending.status, 'disqualified');
		assert.equal(pending.validity.metering.unsettledRequests, QUALIFICATION_EXECUTIONS);
		assert.match(pending.disqualification.reasons.join('; '), /validity\.request-metering/u);

		const mismatched = qualificationReportOf(inputOf(resultsOf({requestOneMismatch: true})));

		assert.equal(mismatched.status, 'disqualified');
		assert.equal(mismatched.validity.requestOne.exactRuns, 0);
		assert.match(mismatched.disqualification.reasons.join('; '), /validity\.request-1-surface/u);
	});

	it('fails closed on incomplete corpus coverage or contaminated isolation', () => {
		const missingProbe = qualificationReportOf(
			inputOf(resultsOf(), {
				preflight: preflightOf({
					cases: loaded.cases.map((testCase) => ({
						caseId: testCase.id,
						pathsPresent: true,
						symbolProbe:
							testCase.class === 'semantic' ? {symbol: testCase.id, path: 'evaluation/fixtures/controlled-typescript/src/model.ts', ok: false} : null,
					})),
				}),
			}),
		);

		assert.equal(missingProbe.status, 'disqualified');
		assert.match(missingProbe.disqualification.reasons.join('; '), /validity\.corpus-coverage/u);

		const externalPath = qualificationReportOf(inputOf(resultsOf({externalPath: true})));

		assert.equal(externalPath.status, 'disqualified');
		assert.equal(externalPath.validity.isolation.cleanRuns, 0);
		assert.match(externalPath.disqualification.reasons.join('; '), /validity\.workspace-isolation/u);

		const unrestored = qualificationReportOf(inputOf(resultsOf({unrestored: true})));

		assert.equal(unrestored.status, 'disqualified');
		assert.equal(unrestored.validity.isolation.restoredRuns, 0);
		assert.match(unrestored.disqualification.reasons.join('; '), /validity\.workspace-isolation/u);

		const insideCheckout = qualificationReportOf(inputOf(resultsOf(), {stateRootOutsideCheckout: false}));

		assert.equal(insideCheckout.status, 'disqualified');
		assert.match(insideCheckout.disqualification.reasons.join('; '), /validity\.workspace-isolation/u);
	});

	it('rejects a contract that is not the accepted validity-v2 contract', () => {
		assert.throws(
			() =>
				qualificationReportOf(
					inputOf(resultsOf(), {
						contract: {...EVALUATION_CONTRACT_PIN, digest: '0'.repeat(64)},
					}),
				),
			/not bound to the accepted validity-v2/u,
		);
	});

	it('aggregates every valid run, including incorrect answers, without shrinking the sample', () => {
		const incorrectCase = loaded.cases[0]?.id ?? 'locate-schema-version';
		const results = resultsOf({failCanonicalCaseId: incorrectCase});
		const report = qualificationReportOf(inputOf(results));

		assert.equal(report.plan.validExecutions, QUALIFICATION_EXECUTIONS);
		assert.equal(report.plan.invalidExecutions, 0);
		assert.equal(report.treatments.canonical.validRuns, QUALIFICATION_EXECUTIONS / 2);
		assert.equal(report.treatments.canonical.successRate, (QUALIFICATION_EXECUTIONS / 2 - QUALIFICATION_REPETITIONS) / (QUALIFICATION_EXECUTIONS / 2));
		assert.equal(report.treatments.noIndex.successRate, 1);
		assert.equal(report.status, 'disqualified');
		assert.match(report.disqualification.reasons.join('; '), /correctness\.no-case-loss-vs-no-index/u);
	});
});
