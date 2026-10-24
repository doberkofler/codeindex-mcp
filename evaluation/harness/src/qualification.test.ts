import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {artifactIdentityOf} from './artifact.ts';
import {assertCanonicalTreatmentOf, canonicalArtifactOf, canonicalArtifactHashOf} from './canonicalArtifact.ts';
import {HARNESS_VERSION} from './cliSupport.ts';
import {EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {LOCAL_CLAIM_CLASS} from './localContract.ts';
import {
	QUALIFICATION_CASE_COUNT,
	QUALIFICATION_EXECUTIONS,
	QUALIFICATION_REPETITIONS,
	QUALIFICATION_SCHEMA_VERSION,
	QUALIFICATION_TREATMENT_IDS,
	assertComparableQualificationBaselines,
	qualificationBaselineOf,
} from './qualificationContract.ts';
import {qualificationReportOf, qualificationSummaryOf} from './qualification.ts';
import {assertReleaseClaimClass} from './releasePreconditions.ts';
import {canonical, CONTENT_HASH, EVALUATION_ROOT, inputOf, loaded, resultsOf, slotsOf} from './qualificationTestSupport.ts';
import {caseHashOf} from './schema.ts';
import {loadSuite} from './suite.ts';
import {treatmentOf} from './treatment.ts';

describe('local-model qualification', () => {
	it('fixes the frozen 18-case, two-treatment, three-repetition plan', () => {
		const plan = slotsOf();

		assert.equal(loaded.suite.status, 'frozen');
		assert.equal(loaded.cases.length, QUALIFICATION_CASE_COUNT);
		assert.equal(loaded.suite.repetitions, QUALIFICATION_REPETITIONS);
		assert.deepEqual(
			loaded.suite.treatments.map((treatment) => treatment.id),
			[...QUALIFICATION_TREATMENT_IDS],
		);
		assert.equal(plan.length, QUALIFICATION_EXECUTIONS);
		assert.equal(new Set(plan.map((slot) => `${slot.caseId}/${slot.treatment}/${slot.repetition}`)).size, QUALIFICATION_EXECUTIONS);

		const release = loadSuite(path.join(EVALUATION_ROOT, 'suites', 'release.json'));

		assert.equal(loaded.suite.revision, release.suite.revision);
		assert.deepEqual(loaded.cases.map((testCase) => testCase.id).sort(), release.cases.map((testCase) => testCase.id).sort());
		assert.deepEqual(
			loaded.cases.map((testCase) => [testCase.id, caseHashOf(testCase)]),
			release.cases.map((testCase) => [testCase.id, caseHashOf(testCase)]),
		);
	});

	it('qualifies a model only when every predeclared criterion passes', () => {
		const report = qualificationReportOf(inputOf(resultsOf()));

		assert.equal(report.status, 'qualified');
		assert.equal(report.claimClass, LOCAL_CLAIM_CLASS);
		assert.equal(report.releaseAuthority, false);
		assert.equal(report.frontierReleaseGate, 'unaffected');
		assert.equal(report.harness.version, HARNESS_VERSION);
		assert.equal(report.schemaVersion, QUALIFICATION_SCHEMA_VERSION);
		assert.equal(report.plan.expectedExecutions, QUALIFICATION_EXECUTIONS);
		assert.equal(report.plan.validExecutions, QUALIFICATION_EXECUTIONS);
		assert.deepEqual(report.contract, EVALUATION_CONTRACT_PIN);
		assert.equal(report.validity.metering.exactRuns, QUALIFICATION_EXECUTIONS);
		assert.equal(report.validity.requestOne.exactRuns, QUALIFICATION_EXECUTIONS);
		assert.equal(report.validity.isolation.cleanRuns, QUALIFICATION_EXECUTIONS);
		assert.equal(report.validity.isolation.restoredRuns, QUALIFICATION_EXECUTIONS);
		assert.equal(report.validity.corpus.result, 'pass');
		assert.equal(report.validity.checks.length, 5);
		assert.equal(
			report.checks.every((check) => check.passed),
			true,
		);
		assert.deepEqual(report.disqualification.reasons, []);
		assert.match(qualificationSummaryOf(report), /claim local-model-scoped release-authority=no/u);
	});

	it('disqualifies a timeout, an incorrect case, and an efficiency regression', () => {
		const timeout = qualificationReportOf(inputOf(resultsOf({timedOut: true})));

		assert.equal(timeout.status, 'disqualified');
		assert.match(timeout.disqualification.reasons.join('; '), /timed-out/u);
		assert.match(timeout.disqualification.reasons.join('; '), /timeout\.no-timed-out-execution/u);

		const incorrect = qualificationReportOf(inputOf(resultsOf({failCanonicalCaseId: loaded.cases[0]?.id ?? 'locate-schema-version'})));

		assert.equal(incorrect.status, 'disqualified');
		assert.match(incorrect.disqualification.reasons.join('; '), /correctness\.no-case-loss-vs-no-index/u);

		const inefficient = qualificationReportOf(inputOf(resultsOf({canonicalBytes: 500})));

		assert.equal(inefficient.status, 'disqualified');
		assert.match(inefficient.disqualification.reasons.join('; '), /efficiency\.target-metric-not-worse/u);
	});

	it('disqualifies an undeclared tool and an incomplete slot plan', () => {
		const undeclared = qualificationReportOf(inputOf(resultsOf({unknownTools: ['mystery']})));

		assert.equal(undeclared.status, 'disqualified');
		assert.match(undeclared.disqualification.reasons.join('; '), /tool-use\.only-captured-tools/u);

		const incomplete = qualificationReportOf(inputOf(resultsOf().slice(1)));

		assert.equal(incomplete.status, 'disqualified');
		assert.equal(incomplete.plan.missingExecutions, 1);
		assert.match(incomplete.disqualification.reasons.join('; '), /missing execution/u);
	});

	it('rejects a model, canonical artifact, revision, case, or duplicate-slot identity mismatch', () => {
		const results = resultsOf();
		const [first] = results;

		assert.ok(first !== undefined);

		assert.throws(
			() => qualificationReportOf(inputOf([{...first, identity: {...first.identity, model: {...first.identity.model, digest: '0'.repeat(64)}}}])),
			/model\.digest/u,
		);
		assert.throws(
			() =>
				qualificationReportOf(
					inputOf([{...first, artifacts: {...first.artifacts, loaded: {id: canonical.id, digest: '0'.repeat(64)}}}], {
						stagedCanonical: {id: canonical.id, digest: '0'.repeat(64)},
					}),
				),
			/differs from the pinned/u,
		);
		assert.throws(
			() =>
				qualificationReportOf(
					inputOf([{...first, identity: {...first.identity, subject: {...first.identity.subject, revision: 'def5678'}}}], {
						subject: {revision: loaded.suite.revision, contentManifestHash: CONTENT_HASH},
					}),
				),
			/subject revision/u,
		);
		assert.throws(() => qualificationReportOf(inputOf([...results, first])), /duplicate slot/u);
	});

	it('keeps model and environment as the only variable across comparable campaigns', () => {
		const baseline = qualificationBaselineOf({
			suite: loaded.suite,
			cases: loaded.cases,
			canonical,
			harnessVersion: HARNESS_VERSION,
		});
		assert.equal(
			baseline,
			qualificationBaselineOf({
				suite: loaded.suite,
				cases: loaded.cases,
				canonical,
				harnessVersion: HARNESS_VERSION,
			}),
		);
		assert.equal(baseline, qualificationReportOf(inputOf(resultsOf())).baseline);
		assert.doesNotThrow(() => {
			assertComparableQualificationBaselines(baseline, baseline);
		});
		assert.throws(() => {
			assertComparableQualificationBaselines(baseline, 'f'.repeat(64));
		}, /not comparable/u);

		const changedCanonical = qualificationBaselineOf({
			suite: loaded.suite,
			cases: loaded.cases,
			canonical: {...canonical, digest: 'e'.repeat(64)},
			harnessVersion: HARNESS_VERSION,
		});

		assert.notEqual(changedCanonical, baseline);
	});

	it('pins the canonical artifact and rejects a moving or unpinned one', (testContext: TestContext) => {
		const treatment = loaded.suite.treatments.find((item) => item.id === 'canonical');

		assert.ok(treatment !== undefined);
		assertCanonicalTreatmentOf(canonical, treatment);
		assert.match(canonicalArtifactHashOf(canonical), /^[0-9a-f]{64}$/u);
		assert.throws(() => {
			assertCanonicalTreatmentOf({...canonical, digest: '0'.repeat(64)}, treatment);
		}, /digest mismatch/u);
		assert.throws(() => {
			canonicalArtifactOf({...canonical, digest: null});
		}, /digest/u);
		assert.throws(() => {
			canonicalArtifactOf({...canonical, id: 'codeindex-mcp-candidate'});
		}, /moving artifact id/u);
		assert.throws(() => {
			canonicalArtifactOf({...canonical, root: 'artifacts/candidate'});
		}, /moving artifact root/u);

		const release = loadSuite(path.join(EVALUATION_ROOT, 'suites', 'release.json'));
		const candidate = release.suite.treatments.find((item) => item.id === 'candidate');

		assert.ok(candidate !== undefined);
		assert.throws(() => {
			assertCanonicalTreatmentOf(canonical, candidate);
		}, /expected the canonical treatment/u);

		const root = mkdtempSync(path.join(tmpdir(), 'codeindex-qualification-artifact-'));
		testContext.onTestFinished(() => {
			rmSync(root, {recursive: true, force: true});
		});
		writeFileSync(path.join(root, 'package.json'), '{"dependencies":{}}\n', 'utf8');
		writeFileSync(path.join(root, 'mcp.mjs'), 'console.log("artifact");\n', 'utf8');
		const ordinaryTools = ['bash', 'glob', 'grep', 'list', 'read'];
		const unpinned = treatmentOf({
			id: 'canonical',
			kind: 'codeindex',
			ordinaryTools,
			codeMode: 'absent',
			artifact: {id: canonical.id, root: canonical.root, entryPoint: canonical.entryPoint, digest: null},
			mcp: {server: 'codeindex', codemode: false},
		});

		assert.throws(() => {
			assertCanonicalTreatmentOf(canonical, unpinned);
		}, /does not pin/u);

		const verified = artifactIdentityOf(root, unpinned);

		assert.equal(verified.declaredDigest, null);

		const wrong = treatmentOf({
			id: 'canonical',
			kind: 'codeindex',
			ordinaryTools,
			codeMode: 'absent',
			artifact: {id: canonical.id, root: canonical.root, entryPoint: canonical.entryPoint, digest: '0'.repeat(64)},
			mcp: {server: 'codeindex', codemode: false},
		});

		assert.throws(() => artifactIdentityOf(root, wrong), /digest mismatch/u);
	});

	it('carries no release authority and is independent of the frontier gate', () => {
		const report = qualificationReportOf(inputOf(resultsOf()));

		assert.equal(report.claimClass, 'local-model-scoped');
		assert.equal(report.releaseAuthority, false);
		assert.equal(report.productRelease.releaseAuthority, false);
		assert.equal(report.productRelease.frontierGate, 'unaffected');
		assert.equal(report.productRelease.claimClass, report.claimClass);
		assert.equal('hosted' in report, false);
		assert.throws(() => {
			assertReleaseClaimClass(report.claimClass);
		}, /expected hosted-model-scoped/u);
	});
});
