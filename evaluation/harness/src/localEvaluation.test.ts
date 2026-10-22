import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {assertLocalClaimClass, LOCAL_CLAIM_CLASS, TARGETED_DIAGNOSTIC_TREATMENT_IDS} from './localContract.ts';
import {targetedDiagnosticReportOf} from './localDiagnostic.ts';
import {localRegressionReportOf, localRegressionSummaryOf} from './localRegression.ts';
import {compare} from './report.ts';
import {callsOf, campaignRunsOf, diagnosticOf, diagnosticRunsOf, metadata, tokenEntry} from './localTestSupport.ts';

describe('local evaluation', () => {
	it('the four-execution diagnostic requires correct candidate answers and a target improvement', () => {
		const report = diagnosticOf({accepted: [200, 220], candidate: [100, 110]});

		assert.equal(report.expectedExecutions, 4);
		assert.equal(report.executions, 4);
		assert.equal(report.claimClass, LOCAL_CLAIM_CLASS);
		assert.equal(report.correctness.candidateCorrect, true);
		assert.equal(report.targetImproved, true);
		assert.deepEqual(report.regressions, []);
		assert.equal(report.passed, true);
		assert.deepEqual(report.treatments, [...TARGETED_DIAGNOSTIC_TREATMENT_IDS]);
	});

	it('the four-execution diagnostic blocks an incorrect candidate answer', () => {
		const report = diagnosticOf({accepted: [200, 220], candidate: [100, 110], candidateSuccess: false});

		assert.equal(report.correctness.candidateCorrect, false);
		assert.equal(report.passed, false);
		assert.match(report.blocking.join('; '), /candidate answer incorrect/u);
	});

	it('the four-execution diagnostic blocks a candidate-controlled metric regression even when the target improves', () => {
		const results = diagnosticRunsOf({accepted: [200, 220], candidate: [100, 110]}).map((run) =>
			run.treatment === 'candidate' ? {...run, toolCalls: [...run.toolCalls, ...callsOf(1, 0)]} : run,
		);
		const report = targetedDiagnosticReportOf({
			results,
			suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64)},
			model: 'ollama/model',
			environment: {id: 'environment-a', hash: '6'.repeat(64)},
			targetMetric: 'retrievalBytes',
		});

		assert.equal(report.targetImproved, true);
		assert.equal(report.passed, false);
		assert.match(report.regressions.join('; '), /toolCalls/u);
		assert.match(report.blockingRegressions.join('; '), /toolCalls/u);
	});

	it('records token and wall-clock regressions as observations without blocking', () => {
		const results = diagnosticRunsOf({accepted: [200, 220], candidate: [100, 110]}).map((run) =>
			run.treatment === 'candidate'
				? {
						...run,
						durationMs: 5000,
						telemetry: {...run.telemetry, inputTokens: tokenEntry(100), outputTokens: tokenEntry(50), reasoningTokens: tokenEntry(1)},
					}
				: run,
		);
		const report = targetedDiagnosticReportOf({
			results,
			suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64)},
			model: 'ollama/model',
			environment: {id: 'environment-a', hash: '6'.repeat(64)},
			targetMetric: 'retrievalBytes',
		});

		assert.equal(report.targetImproved, true);
		assert.match(report.regressions.join('; '), /tokens regressed/u);
		assert.match(report.regressions.join('; '), /wallTimeMs regressed/u);
		assert.deepEqual(report.blockingRegressions, []);
		assert.equal(report.passed, true);
	});

	it('a full local regression reports class trends under the local claim class only', () => {
		const diagnostic = diagnosticOf({accepted: [200, 220], candidate: [100, 110]});
		const report = compare(campaignRunsOf({noIndex: 400, accepted: 300, candidate: 200}), metadata);
		const local = localRegressionReportOf({
			diagnostic,
			report,
			targetMetric: 'retrievalBytes',
			diagnosticRunId: 'diagnostic-run',
			diagnosticDigest: '7'.repeat(64),
		});

		assert.equal(local.claimClass, LOCAL_CLAIM_CLASS);
		assert.equal(local.releaseAuthority, false);
		assert.deepEqual(
			local.trends.map((trend) => trend.caseClass ?? 'overall'),
			['overall', 'locate', 'impact', 'implementation', 'semantic'],
		);
		assert.equal(local.trends[0]?.target.improved, true);
		assert.equal(local.diagnosisRequired, false);
		assert.equal(local.passed, true);
		assert.equal(local.plan.expectedExecutions, 162);
		assert.match(localRegressionSummaryOf(local), /claim local-model-scoped release-authority=no/u);
	});

	it('a statistically supported candidate regression requires targeted diagnosis', () => {
		const diagnostic = diagnosticOf({accepted: [200, 220], candidate: [100, 110]});
		const report = compare(campaignRunsOf({noIndex: 500, accepted: 200, candidate: 400}), metadata);
		const local = localRegressionReportOf({
			diagnostic,
			report,
			targetMetric: 'retrievalBytes',
			diagnosticRunId: 'diagnostic-run',
			diagnosticDigest: '7'.repeat(64),
		});

		assert.equal(
			local.regressions.some((finding) => finding.metric === 'retrievalBytes'),
			true,
		);
		assert.equal(local.diagnosisRequired, true);
		assert.equal(local.passed, false);
	});

	it('a class-stratified regression triggers targeted diagnosis even when the overall target improves', () => {
		const report = compare(
			campaignRunsOf({noIndex: 400, accepted: 300, candidate: 10}, (testCase) =>
				['case-impact-1', 'case-impact-2', 'case-impact-3', 'case-impact-4'].includes(testCase.id)
					? {noIndex: 400, accepted: 300, candidate: 350}
					: {noIndex: 400, accepted: 300, candidate: 10},
			),
			metadata,
		);
		const local = localRegressionReportOf({
			diagnostic: diagnosticOf({accepted: [200, 220], candidate: [100, 110]}),
			report,
			targetMetric: 'retrievalBytes',
			diagnosticRunId: 'diagnostic-run',
			diagnosticDigest: '7'.repeat(64),
		});
		const impact = local.trends.find((trend) => trend.caseClass === 'impact');

		assert.equal(
			impact?.regressions.some((finding) => finding.metric === 'retrievalBytes'),
			true,
		);
		assert.equal(
			local.regressions.some((finding) => finding.caseClass === 'impact' && finding.metric === 'retrievalBytes'),
			true,
		);
		assert.equal(local.diagnosisRequired, true);
	});

	it('local evidence rejects a hosted claim class and a mismatched target metric', () => {
		assert.throws(() => {
			assertLocalClaimClass('hosted-model-scoped');
		}, /expected local-model-scoped/u);

		const diagnostic = diagnosticOf({accepted: [200, 220], candidate: [100, 110]});
		const report = compare(campaignRunsOf({noIndex: 400, accepted: 300, candidate: 200}), {...metadata, claimClass: 'hosted-model-scoped'});

		assert.throws(
			() =>
				localRegressionReportOf({
					diagnostic,
					report,
					targetMetric: 'retrievalBytes',
					diagnosticRunId: 'diagnostic-run',
					diagnosticDigest: '7'.repeat(64),
				}),
			/expected local-model-scoped/u,
		);

		const localReport = compare(campaignRunsOf({noIndex: 400, accepted: 300, candidate: 200}), metadata);

		assert.throws(
			() =>
				localRegressionReportOf({
					diagnostic,
					report: localReport,
					targetMetric: 'toolCalls',
					diagnosticRunId: 'diagnostic-run',
					diagnosticDigest: '7'.repeat(64),
				}),
			/differs from regression target/u,
		);
	});
});
