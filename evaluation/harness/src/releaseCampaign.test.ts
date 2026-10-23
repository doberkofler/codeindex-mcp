import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext, vi} from 'vitest';
import {releaseCommand} from './cliRelease.ts';
import {hashOf} from './hash.ts';
import {hostedReferenceHashOf, hostedReferenceOf, type HostedReferenceType} from './hostedReference.ts';
import {
	assertReleaseClaimClass,
	modelFreePreconditionOf,
	RELEASE_CLAIM_CLASS,
	releaseCampaignReportOf,
	releaseCampaignSummaryOf,
	type ReleaseExpectationType,
} from './releaseCampaign.ts';
import {compare} from './report.ts';
import {CASE_LAYOUT, campaignRunsOf, metadata} from './localTestSupport.ts';

const hosted = (overrides: Readonly<Record<string, unknown>> = {}): HostedReferenceType =>
	hostedReferenceOf({
		schemaVersion: 1,
		id: 'hosted-a',
		recordedAt: '2026-10-22T00:00:00.000Z',
		provider: 'deepseek',
		modelId: 'deepseek-v4-pro',
		reference: 'deepseek/deepseek-v4-pro',
		releasedAt: '2026-08-13T00:00:00.000Z',
		runtime: {opencode: '2.1.2'},
		generation: {temperature: null, topP: null, topK: null, repeatPenalty: null, stop: []},
		...overrides,
	});

const suite = {
	id: 'suite-a',
	version: 1,
	hash: 'b'.repeat(64),
	revision: 'abc1234',
};

const artifacts = {
	accepted: {id: 'accepted', digest: 'c'.repeat(64)},
	candidate: {id: 'candidate', digest: 'd'.repeat(64)},
};

const cases = CASE_LAYOUT.map((testCase) => ({id: testCase.id, hash: hashOf(testCase.id)}));

const expectation: ReleaseExpectationType = {suite, cases, targetMetric: 'retrievalBytes', artifacts};

const routeReport = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
	recordType: 'route-report',
	schemaVersion: 1,
	suite: {...suite},
	revision: suite.revision,
	artifacts,
	cases: cases.map((testCase) => ({caseId: testCase.id, class: 'impact', expectedFiles: [], treatments: {}, answerEquality: true})),
	gates: [
		{id: 'G-E1a', result: 'pass'},
		{id: 'G-E1b', result: 'pass'},
		{id: 'G-E1c', result: 'pass'},
	],
	passed: true,
	...overrides,
});

const expectedSlots = CASE_LAYOUT.flatMap((testCase) =>
	['no-index', 'accepted', 'candidate'].flatMap((treatment) =>
		Array.from({length: 5}, (_, index) => ({caseId: testCase.id, treatment, repetition: index + 1})),
	),
);

type ReleaseValuesType = Readonly<{noIndex: number; accepted: number; candidate: number}>;

type ReleaseReportType = Readonly<{
	results: ReturnType<typeof campaignRunsOf>;
	report: ReturnType<typeof compare>;
	record: ReturnType<typeof releaseCampaignReportOf>;
}>;

const DEFAULT_VALUES: ReleaseValuesType = {noIndex: 500, accepted: 300, candidate: 200};

const releaseReport = (values?: ReleaseValuesType, override?: Parameters<typeof campaignRunsOf>[1]): ReleaseReportType => {
	const runs = campaignRunsOf(values ?? DEFAULT_VALUES, override, 5);
	const report = compare(runs, {...metadata, claimClass: RELEASE_CLAIM_CLASS});

	return {
		results: runs,
		report,
		record: releaseCampaignReportOf({
			hosted: hosted(),
			expectation,
			preconditions: {modelFree: modelFreePreconditionOf(routeReport(), expectation)},
			expectedSlots,
			results: runs,
			report,
		}),
	};
};

const releaseFlags = (extra: Readonly<Record<string, string[]>> = {}): Map<string, string[]> =>
	new Map<string, string[]>([
		['suite', ['suites/release.json']],
		['hosted-reference', ['references/deepseek-flash.json']],
		['target-metric', ['retrievalBytes']],
		['dry-run', ['true']],
		...Object.entries(extra),
	]);

const subjectFixtureOf = (testContext: TestContext): Readonly<{subjectRepo: string}> => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-release-subject-'));

	writeFileSync(path.join(root, 'package.json'), '{"name":"release-fixture"}\n');
	writeFileSync(path.join(root, 'README.md'), '# release fixture\n');
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return {subjectRepo: root};
};

describe('hosted release campaign', () => {
	it('reports a complete 270-slot campaign with class verdicts and paired intervals', () => {
		const {record} = releaseReport();

		assert.equal(record.claimClass, RELEASE_CLAIM_CLASS);
		assert.equal(record.releaseAuthority, true);
		assert.equal(record.plan.expectedExecutions, 270);
		assert.equal(record.plan.executions, 270);
		assert.equal(record.plan.validExecutions, 270);
		assert.equal(record.plan.invalidExecutions, 0);
		assert.equal(record.slots.length, 270);
		assert.equal(
			record.slots.every((slot) => slot.status === 'valid' && slot.cause === null),
			true,
		);
		assert.equal(record.passed, true);
		assert.deepEqual(
			record.classes.map((verdict) => verdict.class),
			['locate', 'impact', 'implementation', 'semantic'],
		);

		for (const verdict of [record.overall, ...record.classes]) {
			assert.equal(verdict.target.medianRatio, 0.6666666666666666);
			assert.notEqual(verdict.target.ratioInterval95, null);
			assert.equal(verdict.target.ratioInterval95?.method, 'paired-by-case-percentile-bootstrap');
			assert.equal(verdict.regressions.length, 0);
			assert.equal(verdict.passed, true);
		}

		assert.deepEqual(Object.keys(record.preconditions), ['modelFree']);
		assert.equal(record.preconditions.modelFree.kind, 'model-free');
		assert.match(releaseCampaignSummaryOf(record), /claim hosted-model-scoped release-authority=yes/u);
	});

	it('invalidates a missing execution with a cause and fails the campaign', () => {
		const runs = campaignRunsOf({noIndex: 500, accepted: 300, candidate: 200}, undefined, 5);
		const report = compare(runs, {...metadata, claimClass: RELEASE_CLAIM_CLASS});
		const record = releaseCampaignReportOf({
			hosted: hosted(),
			expectation,
			preconditions: {modelFree: modelFreePreconditionOf(routeReport(), expectation)},
			expectedSlots,
			results: runs.slice(0, -1),
			report,
		});
		const missing = record.slots.find((slot) => slot.status === 'invalid');

		assert.equal(record.plan.invalidExecutions, 1);
		assert.equal(missing?.cause, 'missing execution');
		assert.equal(record.passed, false);
		assert.match(record.blocking.join('; '), /missing execution/u);
	});

	it('fails when the target metric does not improve and the paired interval shows a regression', () => {
		const {record} = releaseReport({noIndex: 500, accepted: 300, candidate: 400});

		assert.equal(record.overall.target.medianRatio, 1.3333333333333333);
		assert.equal(
			record.overall.regressions.some((regression) => regression.metric === 'retrievalBytes'),
			true,
		);
		assert.equal(record.passed, false);
		assert.match(record.blocking.join('; '), /target metric retrievalBytes did not improve/u);
		assert.match(record.blocking.join('; '), /retrievalBytes candidate\/accepted ratio/u);
	});

	it('rejects model-free evidence that is failing, stale, incomplete, or artifact-mismatched', () => {
		assert.throws(() => modelFreePreconditionOf(routeReport({gates: [{id: 'G-E1a', result: 'fail'}]}), expectation), /model-free gate did not pass/u);
		assert.throws(() => modelFreePreconditionOf(routeReport({passed: false}), expectation), /model-free report did not pass/u);
		assert.throws(
			() =>
				modelFreePreconditionOf(routeReport({artifacts: {accepted: artifacts.accepted, candidate: {id: 'candidate', digest: 'f'.repeat(64)}}}), expectation),
			/different artifacts/u,
		);
		assert.throws(() => modelFreePreconditionOf(routeReport({suite: {...suite, version: 2}}), expectation), /covers suite/u);
		assert.throws(() => modelFreePreconditionOf(routeReport({suite: {...suite, revision: 'def5678'}}), expectation), /covers revision/u);
		assert.throws(() => modelFreePreconditionOf(routeReport({cases: []}), expectation), /does not cover the frozen/u);
		assert.throws(() => modelFreePreconditionOf(routeReport({recordType: 'local-regression'}), expectation), /must be a route-report/u);
	});

	it('rejects a local claim class as release authority', () => {
		assert.throws(() => {
			assertReleaseClaimClass('local-model-scoped');
		}, /expected hosted-model-scoped/u);
	});

	it('accepts model-free evidence bound to another suite hash when cases, revision, and artifacts match', () => {
		const routeSuite = {...suite, hash: 'f'.repeat(64)};
		const route = modelFreePreconditionOf(routeReport({suite: routeSuite}), expectation);

		assert.equal(route.suite.hash, routeSuite.hash);
	});

	it('a changed hosted reference is a different pinned identity', () => {
		const first = hosted();
		const second = hosted({releasedAt: '2026-09-01T00:00:00.000Z'});

		assert.notEqual(first.releasedAt, second.releasedAt);
		assert.notEqual(hostedReferenceHashOf(first), hostedReferenceHashOf(second));
	});

	it('pins the selected hosted reference and runtime', () => {
		const file = path.resolve(import.meta.dirname, '../../references/deepseek-flash.json');
		const reference = hostedReferenceOf(JSON.parse(readFileSync(file, 'utf8')) as unknown);

		assert.equal(reference.reference, 'deepseek/deepseek-flash');
		assert.equal(reference.releasedAt, '2026-10-17T00:00:00.000Z');
		assert.equal(reference.runtime.opencode, '2.1.2');
		assert.equal(hostedReferenceHashOf(reference), 'e3d86f8914fe9b9d77e9048216acd1535a44cf98b7e69a35edb3a1cf19dae07e');
	});

	it('plans the 270 hosted slots without local evidence', async (testContext: TestContext) => {
		const capture = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		let output = '';

		try {
			await releaseCommand(releaseFlags(), {settings: subjectFixtureOf(testContext)});
			output = capture.mock.calls.map(([chunk]) => (typeof chunk === 'string' ? chunk : chunk.toString())).join('');
		} finally {
			capture.mockRestore();
		}

		assert.match(output, /plan 270 execution\(s\): 18 case\(s\) x 3 treatment\(s\) x 5 repetition\(s\)/u);
		assert.doesNotMatch(output, /local-regression/u);
	});

	it('does not read a supplied local qualification path', async (testContext: TestContext) => {
		const capture = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		let output = '';

		try {
			await releaseCommand(releaseFlags({'local-regression': ['results/local/missing/local-regression.json']}), {
				settings: subjectFixtureOf(testContext),
			});
			output = capture.mock.calls.map(([chunk]) => (typeof chunk === 'string' ? chunk : chunk.toString())).join('');
		} finally {
			capture.mockRestore();
		}

		assert.match(output, /plan 270 execution\(s\)/u);
	});
});
