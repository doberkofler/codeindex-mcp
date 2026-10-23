import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {EVALUATION_CONTRACT, TARIFF_SNAPSHOT} from './economicContract.ts';
import {runOf} from './localTestSupport.ts';
import {reconcileProviderMeterLedger, type ProviderRequestLedgerEntryType} from './providerMeterLedger.ts';
import {type ProviderTokenUsageType} from './providerUsage.ts';
import {type RunResultType} from './runTypes.ts';
import {type CaseType} from './schema.ts';
import {aaCalibrationOf} from './aaAnalysis.ts';
import {AA_ECONOMIC_EFFECT, aaPlanOf, aaWeightsOf} from './aaPlan.ts';
import {deterministicValidityOf, providerMeterSelfCheckOf, validitySmokeOf} from './validityGates.ts';

const usageOf = (overrides: Partial<ProviderTokenUsageType> = {}): ProviderTokenUsageType => ({
	nonCachedInputTokens: 100,
	cacheReadTokens: 10,
	cacheWriteTokens: {},
	visibleOutputTokens: 20,
	reasoningTokens: 5,
	reportedCostUsd: null,
	missingFields: [],
	invalidFields: [],
	complete: true,
	...overrides,
});

const requestOf = (
	ordinal: number,
	kind: ProviderRequestLedgerEntryType['kind'],
	at: string,
	usage: ProviderTokenUsageType = usageOf(),
): ProviderRequestLedgerEntryType => ({
	ordinal,
	kind,
	provider: 'deepseek',
	model: 'deepseek-flash',
	startedAt: at,
	completedAt: at,
	toolNames: [],
	requestBytes: 10,
	responseBytes: 10,
	settlement: {status: 'completed', usage},
});

const meterOf = (): NonNullable<RunResultType['providerMeter']> =>
	reconcileProviderMeterLedger({
		recordType: 'provider-meter',
		provider: 'deepseek',
		requests: [requestOf(1, 'agent', '2026-10-23T05:00:00.000Z'), requestOf(2, 'title', '2026-10-23T05:00:01.000Z')],
	});

const costOf = (totalUsd: number, titleUsd = 0.001): NonNullable<RunResultType['providerCost']> => ({
	recordType: 'task-cost-vector',
	state: 'exact',
	currency: 'USD',
	basis: 'official-provider-tariff-snapshot',
	claim: 'total-user-visible-task-cost-not-invoice',
	invoiceTime: false,
	totalUsd,
	agentOnlyUsd: totalUsd - titleUsd,
	components: {nonCachedInputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: {}, visibleOutputTokens: 20, reasoningTokens: 5},
	requests: [
		{
			ordinal: 1,
			kind: 'agent',
			provider: 'deepseek',
			model: 'deepseek-flash',
			completedAt: '2026-10-23T05:00:00.000Z',
			billingBand: 'offPeak',
			usage: usageOf(),
			components: {nonCachedInputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: {}, visibleOutputTokens: 20, reasoningTokens: 5},
			costUsd: totalUsd - titleUsd,
			state: 'exact',
			reason: null,
		},
		{
			ordinal: 2,
			kind: 'title',
			provider: 'deepseek',
			model: 'deepseek-flash',
			completedAt: '2026-10-23T05:00:01.000Z',
			billingBand: 'offPeak',
			usage: usageOf({nonCachedInputTokens: 0, cacheReadTokens: 0, visibleOutputTokens: 10, reasoningTokens: 0}),
			components: {nonCachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: {}, visibleOutputTokens: 10, reasoningTokens: 0},
			costUsd: titleUsd,
			state: 'exact',
			reason: null,
		},
	],
	requestCount: 2,
	requestKinds: {agent: 1, title: 1},
	tariff: TARIFF_SNAPSHOT,
	tariffSnapshotAt: TARIFF_SNAPSHOT.retrievedAt,
	reason: null,
});

const testCaseOf = (id: string): CaseType => ({
	schemaVersion: 1,
	id,
	title: id,
	class: 'locate',
	tags: ['locate'],
	prompt: `Which file defines ${id}?`,
	scope: ['src/**'],
	expectedFiles: [`src/${id}.ts`],
	contextFiles: [],
	forbiddenFiles: [],
	workflow: {
		maxTotalCalls: 12,
		requiredFirstTool: null,
		maxOutputBytes: 100_000,
		requiredTools: [],
		forbiddenTools: [],
		maxCallsByFamily: {},
		maxOutputBytesByFamily: {},
		maxDuplicateReads: null,
		maxFallbacksAfterAuthoritative: null,
		maxBroadSearches: null,
		maxDurationMs: 180_000,
		maxTokens: null,
	},
	check: null,
	timeoutMs: 180_000,
});

const aaRunOf = (caseId: string, repetition: number, costUsd: number, overrides: Partial<RunResultType> = {}): RunResultType => ({
	...runOf({caseId, treatment: 'no-index', repetition, success: true}),
	providerCost: costOf(costUsd),
	providerMeter: meterOf(),
	...overrides,
});

const cases = [testCaseOf('locate-schema-version'), testCaseOf('locate-read-symbol-tool')];

const aaOf = (runs: readonly RunResultType[], repetitions = 2): ReturnType<typeof aaCalibrationOf> =>
	aaCalibrationOf({runs, cases, repetitionsPerCase: repetitions, seed: 'a'.repeat(64)});

const aaRunsOf = (costs: Readonly<Record<string, readonly number[]>>): readonly RunResultType[] =>
	cases.flatMap((testCase) => (costs[testCase.id] ?? []).map((cost, index) => aaRunOf(testCase.id, index + 1, cost)));

const planOrderOf = (plan: ReturnType<typeof aaPlanOf>): readonly string[] =>
	plan.pairs.map((pair) =>
		plan.plan
			.filter((entry) => entry.caseId === pair.caseId && (entry.repetition === pair.armARepetition || entry.repetition === pair.armBRepetition))
			.map((entry) => (entry.repetition === pair.armARepetition ? 'a' : 'b'))
			.join(''),
	);

describe('validity calibration', () => {
	it('builds a deterministic randomized A/A plan with odd/even labels', () => {
		const plan = aaPlanOf(cases, 2, 'seed-a');
		const ordered = planOrderOf(plan);

		assert.equal(plan.plan.length, 8);
		assert.equal(plan.pairs.length, 4);
		assert.deepEqual(
			plan.pairs.map((pair) => pair.first),
			ordered.map((order) => order[0]),
		);
		assert.deepEqual(aaPlanOf(cases, 2, 'seed-a'), plan);
		assert.equal(plan.plan.filter((entry) => entry.caseId === 'locate-schema-version').length, 4);
	});

	it('measures no material label effect for two identical arms', () => {
		const runs = aaRunsOf({'locate-schema-version': [1, 1.01, 1.02, 0.99], 'locate-read-symbol-tool': [2, 2.02, 1.98, 2.01]});
		const aa = aaOf(runs);

		assert.equal(aa.plannedSlots, 8);
		assert.equal(aa.storedSlots, 8);
		assert.equal(aa.validPairs, 4);
		assert.equal(aa.failures.length, 0);
		assert.equal(aa.labelEffect.equivalence.passed, true);
		assert.equal(aa.labelEffect.equivalence.economicEffect, AA_ECONOMIC_EFFECT);
		assert.ok((aa.labelEffect.equivalence.interval95?.low ?? 0) >= 1 / 1.1);
		assert.ok((aa.labelEffect.equivalence.interval95?.high ?? 2) <= 1.1);
		assert.ok((aa.variance.withinCaseVariance ?? 0) > 0);
		assert.equal(aa.treatmentLabelInvariance.identical, true);
		assert.equal(aa.diagnostics.a.titleRequests, 4);
		assert.equal(aa.diagnostics.b.titleRequests, 4);
		assert.ok((aa.diagnostics.a.cacheHitRate ?? 0) > 0);
		assert.ok((aa.sampleSize.chosenRepetitions ?? 0) >= 1);
		assert.equal(aa.sampleSize.designEffectRatio, 0.85);
		assert.equal(aa.sampleSize.assumedEffectLogRatio, Math.log(0.85));
		assert.equal(aa.sampleSize.finalCaseCount, 18);
		assert.equal(aa.passed, true);
	});

	it('rejects a material label effect beyond the predeclared economic margin', () => {
		const runs = aaRunsOf({'locate-schema-version': [1, 1, 1, 1], 'locate-read-symbol-tool': [1, 1, 1, 1]}).map((run) =>
			run.repetition % 2 === 0 ? {...run, providerCost: costOf(2)} : run,
		);
		const aa = aaOf(runs);

		assert.equal(aa.labelEffect.equivalence.passed, false);
		assert.match(aa.labelEffect.equivalence.reason ?? '', /outside/u);
		assert.equal(aa.passed, false);
	});

	it('retains missing, invalid, and contaminated executions with closed causes', () => {
		const runs = aaRunsOf({'locate-schema-version': [1, 1.01, 1.02, 0.99], 'locate-read-symbol-tool': [2, 2.02, 1.98, 2.01]}).filter(
			(run) => !(run.caseId === 'locate-schema-version' && run.repetition === 2),
		);
		const contaminated = runs.map((run) =>
			run.caseId === 'locate-read-symbol-tool' && run.repetition === 3
				? {...run, valid: false, defects: ['external-path-attempt' as const], invalidReason: 'denied external-directory access 1 time(s)'}
				: run,
		);
		const aa = aaOf(contaminated);

		assert.equal(aa.plannedSlots, 8);
		assert.equal(aa.storedSlots, 7);
		assert.equal(aa.failureRate.missing, 1);
		assert.equal(aa.failureRate.byCause['missing-execution'], 1);
		assert.equal(aa.failureRate.byCause['external-path-contamination'], 1);
		assert.equal(aa.failures.length, 2);
		assert.equal(aa.labelEffect.cost.state, 'exact');
		assert.equal(aa.labelEffect.equivalence.passed, false);
		assert.match(aa.labelEffect.equivalence.reason ?? '', /missing or invalid/u);
		assert.equal(aa.passed, false);
	});

	it('requires a frozen, class-balanced case weight for every calibration case', () => {
		const weights = aaWeightsOf(EVALUATION_CONTRACT, ['locate-schema-version', 'locate-read-symbol-tool']);
		const missing = {
			...EVALUATION_CONTRACT,
			suite: {...EVALUATION_CONTRACT.suite, caseWeights: {'locate-schema-version': 1}},
		};

		assert.equal(weights['locate-schema-version'], 0.5);
		assert.equal(weights['locate-read-symbol-tool'], 0.5);
		assert.throws(() => aaWeightsOf(missing, ['locate-schema-version', 'locate-read-symbol-tool']), /no positive frozen contract weight/u);
	});

	it('classifies a smoke as validity evidence only', () => {
		const runs = [aaRunOf('semantic-renamed-reexport', 1, 1)];
		const smoke = validitySmokeOf({
			runs,
			caseIds: ['semantic-renamed-reexport'],
			semanticFixturesIndexed: true,
			corpusPreflightPassed: true,
			requestOneSurfacePassed: true,
		});

		assert.equal(smoke.claimClass, 'validity-only');
		assert.equal(smoke.efficacyClaim, false);
		assert.equal(smoke.releaseAuthority, false);
		assert.equal(smoke.meteringComplete, true);
		assert.equal(smoke.pathsClean, true);
		assert.equal(smoke.requestKinds['title'], 1);
		assert.equal(smoke.passed, true);
	});

	it('blocks hosted spend unless every deterministic gate passes', () => {
		const passed = deterministicValidityOf({
			contractAccepted: true,
			metering: {passed: true, detail: 'self-check'},
			surface: [
				{treatmentId: 'no-index', coldStarts: 20, passed: true, detail: 'ok'},
				{treatmentId: 'accepted', coldStarts: 20, passed: true, detail: 'ok'},
			],
			corpus: {passed: true, detail: 'pass'},
			pathIsolation: {passed: true, detail: 'outside'},
		});
		const failed = deterministicValidityOf({
			contractAccepted: true,
			metering: {passed: true, detail: 'self-check'},
			surface: [{treatmentId: 'accepted', coldStarts: 19, passed: true, detail: 'short'}],
			corpus: {passed: true, detail: 'pass'},
			pathIsolation: {passed: true, detail: 'outside'},
		});

		assert.equal(passed.passed, true);
		assert.equal(passed.gates.length, 5);
		assert.equal(failed.passed, false);
		assert.equal(failed.gates.find((gate) => gate.id === 'request-1-surface')?.passed, false);
	});

	it('meters and settles a synthetic request without hosted spend', async () => {
		const selfCheck = await providerMeterSelfCheckOf();

		assert.equal(selfCheck.passed, true);
		assert.equal(selfCheck.requestCount, 1);
		assert.equal(selfCheck.settledExactlyOnce, true);
		assert.equal(selfCheck.economicClaim, 'exact');
	});
});
