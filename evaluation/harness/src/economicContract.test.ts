import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, it} from 'vitest';
import {
	ECONOMIC_CONTRACT_ID,
	EVALUATION_CONTRACT,
	EVALUATION_CONTRACT_DIGEST,
	EVALUATION_CONTRACT_PIN,
	TARIFF_SNAPSHOT,
	assertAcceptedContractOf,
	contractDigestOf,
	contractPinOfUnknown,
	contractRecordOf,
	type TariffSnapshotType,
} from './economicContract.ts';
import {type EconomicExecutionType, economicExecutionsOf, fixedSuiteCostStudyOf} from './costStudy.ts';
import {hashOf} from './hash.ts';
import {compare, type ReportMetadataType} from './report.ts';
import {finalSampleSizeOf} from './sampleSizeSimulation.ts';
import {requestCostVectorOf, tariffSensitivityOf, taskCostVectorOf, type TaskCostVectorType} from './taskCost.ts';
import {type ProviderRequestLedgerEntryType} from './providerMeterLedger.ts';
import {type ProviderTokenUsageType} from './providerUsage.ts';
import {runOf} from './localTestSupport.ts';
import {type RunResultType} from './runTypes.ts';
import {ratioOf, ratioValueOf} from './ratio.ts';

const usageOf = (overrides: Partial<ProviderTokenUsageType> = {}): ProviderTokenUsageType => ({
	nonCachedInputTokens: 1_000_000,
	cacheReadTokens: 0,
	cacheWriteTokens: {},
	visibleOutputTokens: 1_000_000,
	reasoningTokens: 0,
	reportedCostUsd: null,
	missingFields: [],
	invalidFields: [],
	complete: true,
	...overrides,
});

const requestOf = (
	overrides: Partial<ProviderRequestLedgerEntryType> & Readonly<{kind: ProviderRequestLedgerEntryType['kind']}>,
): ProviderRequestLedgerEntryType => ({
	ordinal: 1,
	provider: 'deepseek',
	model: 'deepseek-flash',
	startedAt: '2026-10-24T05:00:00.000Z',
	completedAt: '2026-10-24T05:00:01.000Z',
	toolNames: [],
	requestBytes: 1,
	responseBytes: 1,
	settlement: {status: 'completed', usage: usageOf()},
	...overrides,
});

const taskOf = (requests: readonly ProviderRequestLedgerEntryType[], tariff = TARIFF_SNAPSHOT): TaskCostVectorType =>
	taskCostVectorOf({recordType: 'provider-meter', provider: 'deepseek', requests}, tariff);

const executionOf = (overrides: Partial<EconomicExecutionType> = {}): EconomicExecutionType => ({
	caseId: 'case-a',
	caseClass: 'locate',
	treatment: 'no-index',
	repetition: 1,
	valid: true,
	correct: true,
	falseAbsence: false,
	timedOut: false,
	durationMs: 1000,
	timeoutMs: 180_000,
	costUsd: 1,
	costState: 'exact',
	allToolOutputBytes: 100,
	toolOutputByFamily: {read: 100},
	...overrides,
});

const studyOptions = {
	weights: {'case-a': 0.5, 'case-b': 0.5},
	targetRatio: 0.9,
	confidence: 0.95,
	resamples: 500,
	seed: 'a'.repeat(64),
} as const;

const costVectorOf = (totalUsd: number): TaskCostVectorType => ({
	recordType: 'task-cost-vector',
	state: 'exact',
	currency: 'USD',
	basis: 'official-provider-tariff-snapshot',
	claim: 'total-user-visible-task-cost-not-invoice',
	invoiceTime: false,
	totalUsd,
	agentOnlyUsd: totalUsd,
	components: {nonCachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: {}, visibleOutputTokens: 1, reasoningTokens: 0},
	requests: [],
	requestCount: 0,
	requestKinds: {agent: 1},
	tariff: TARIFF_SNAPSHOT,
	tariffSnapshotAt: TARIFF_SNAPSHOT.retrievedAt,
	reason: null,
});

describe('economic contract', () => {
	it('retains the accepted contract and the official tariff snapshot', () => {
		const tariffFile = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../tariffs/deepseek-flash-2026-10-23.json'), 'utf8')) as unknown;
		const contractFile = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../contracts/evaluation-validity-v2.json'), 'utf8')) as unknown;

		assert.deepEqual(tariffFile, TARIFF_SNAPSHOT);
		assert.deepEqual(contractFile, EVALUATION_CONTRACT);
		assert.equal(EVALUATION_CONTRACT.id, ECONOMIC_CONTRACT_ID);
		assert.equal(EVALUATION_CONTRACT.cost.targetRatio, 0.9);
		assert.equal(EVALUATION_CONTRACT.cost.upperBoundBelow, 1);
		assert.equal(EVALUATION_CONTRACT.correctness.falseAbsenceTolerance, 0);
		assert.equal(EVALUATION_CONTRACT.latency.optimizationTarget, false);
		assert.equal(EVALUATION_CONTRACT.suite.caseCount, Object.keys(EVALUATION_CONTRACT.suite.caseWeights).length);
		assert.equal(EVALUATION_CONTRACT_DIGEST, contractDigestOf(EVALUATION_CONTRACT));
		assertAcceptedContractOf(EVALUATION_CONTRACT_PIN);
	});

	it('rejects a threshold or weight changed after the contract was frozen', () => {
		const changedThreshold = {...EVALUATION_CONTRACT, cost: {...EVALUATION_CONTRACT.cost, targetRatio: 0.95}};
		const changedWeight = {...EVALUATION_CONTRACT, suite: {...EVALUATION_CONTRACT.suite, caseWeights: {'case-a': 1}}};
		const record = contractRecordOf();

		assert.notEqual(contractDigestOf(changedThreshold), EVALUATION_CONTRACT_DIGEST);
		assert.notEqual(contractDigestOf(changedWeight), EVALUATION_CONTRACT_DIGEST);
		assert.deepEqual(contractPinOfUnknown(record), EVALUATION_CONTRACT_PIN);
		assert.throws(() => contractPinOfUnknown({...record, cost: changedThreshold.cost}), /does not match its digest/u);
		assert.throws(() => contractPinOfUnknown(contractRecordOf(changedThreshold)), /not the accepted/u);
	});

	it('prices every request kind, including title and compaction, and retains per-request vectors', () => {
		const ledger = taskOf([
			requestOf({ordinal: 1, kind: 'agent'}),
			requestOf({ordinal: 2, kind: 'title', settlement: {status: 'completed', usage: usageOf({nonCachedInputTokens: 0, visibleOutputTokens: 10})}}),
			requestOf({ordinal: 3, kind: 'compaction', settlement: {status: 'completed', usage: usageOf({nonCachedInputTokens: 0, visibleOutputTokens: 20})}}),
		]);

		assert.equal(ledger.state, 'exact');
		assert.equal(ledger.requestCount, 3);
		assert.deepEqual(ledger.requestKinds, {agent: 1, title: 1, compaction: 1});
		assert.equal(ledger.requests.length, 3);
		assert.equal(ledger.totalUsd, 0.15 + 0.6 + (10 * 0.6) / 1_000_000 + (20 * 0.6) / 1_000_000);
		assert.equal(ledger.agentOnlyUsd, 0.75);
		assert.equal(ledger.basis, 'official-provider-tariff-snapshot');
		assert.equal(ledger.claim, 'total-user-visible-task-cost-not-invoice');
		assert.equal(ledger.invoiceTime, false);
		assert.equal(ledger.tariffSnapshotAt, TARIFF_SNAPSHOT.retrievedAt);
	});

	it('uses the provider billing band at each request timestamp', () => {
		const peak = requestCostVectorOf(requestOf({kind: 'agent', completedAt: '2026-10-23T02:00:00.000Z'}), TARIFF_SNAPSHOT);
		const offPeak = requestCostVectorOf(requestOf({kind: 'agent', completedAt: '2026-10-23T05:00:00.000Z'}), TARIFF_SNAPSHOT);
		const holiday = requestCostVectorOf(requestOf({kind: 'agent', completedAt: '2026-10-23T02:00:00.000Z'}), {
			...TARIFF_SNAPSHOT,
			holidayExclusions: ['2026-10-23'],
		});

		assert.equal(peak.billingBand, 'peak');
		assert.equal(offPeak.billingBand, 'offPeak');
		assert.equal(holiday.billingBand, 'offPeak');
		assert.equal(peak.costUsd, 0.3 + 1.2);
		assert.equal(offPeak.costUsd, 0.15 + 0.6);
	});

	it('prices each cache-write tier separately and invalidates a missing tariff tier', () => {
		const tariff: TariffSnapshotType = {
			...TARIFF_SNAPSHOT,
			id: 'tiered',
			bands: {
				...TARIFF_SNAPSHOT.bands,
				offPeak: {...TARIFF_SNAPSHOT.bands.offPeak, cacheWritePerMillionUsd: {fiveMinute: 2, oneHour: 3}},
			},
		};
		const usage = usageOf({nonCachedInputTokens: 0, visibleOutputTokens: 0, cacheWriteTokens: {fiveMinute: 1_000_000, oneHour: 1_000_000}});
		const request = requestOf({kind: 'agent', settlement: {status: 'completed', usage}});
		const exact = requestCostVectorOf(request, tariff);
		const missing = requestCostVectorOf(
			requestOf({kind: 'agent', settlement: {status: 'completed', usage: {...usage, cacheWriteTokens: {unknownTier: 1}}}}),
			tariff,
		);

		assert.equal(exact.costUsd, 5);
		assert.deepEqual(exact.components?.cacheWriteTokens, {fiveMinute: 1_000_000, oneHour: 1_000_000});
		assert.equal(missing.state, 'unavailable');
		assert.match(missing.reason ?? '', /no tariff rate/u);
	});

	it('invalidates the task total when a component or settlement is missing', () => {
		const missing = taskOf([
			requestOf({
				kind: 'agent',
				settlement: {status: 'completed', usage: usageOf({cacheReadTokens: null, missingFields: ['cacheReadTokens'], complete: false})},
			}),
		]);
		const failed = taskOf([requestOf({kind: 'agent', settlement: {status: 'failed', cause: 'usage-missing', httpStatus: 200}})]);
		const pending = taskOf([requestOf({kind: 'agent', settlement: null})]);

		assert.equal(missing.state, 'unavailable');
		assert.equal(missing.totalUsd, null);
		assert.match(missing.reason ?? '', /missing provider components/u);
		assert.equal(failed.state, 'unavailable');
		assert.match(failed.reason ?? '', /failed/u);
		assert.equal(pending.state, 'unavailable');
		assert.match(pending.reason ?? '', /not settled/u);
	});

	it('labels alternative-tariff arithmetic as sensitivity over the retained vector, never as an invoice', () => {
		const ledger = taskOf([requestOf({kind: 'agent'})]);
		const cheaper: TariffSnapshotType = {
			...TARIFF_SNAPSHOT,
			id: 'cheaper',
			bands: {
				peak: TARIFF_SNAPSHOT.bands.peak,
				offPeak: {
					cacheReadInputPerMillionUsd: 0,
					cacheMissInputPerMillionUsd: 0,
					cacheWritePerMillionUsd: {},
					outputPerMillionUsd: 0,
					reasoningPerMillionUsd: 0,
				},
			},
		};
		const sensitivity = tariffSensitivityOf(ledger, cheaper);

		assert.equal(sensitivity.amount, 0);
		assert.equal(sensitivity.basis, 'static-tariff-arithmetic');
		assert.equal(sensitivity.claim, 'sensitivity-not-invoice-time');
		assert.equal(sensitivity.invoiceTime, false);
		assert.notEqual(sensitivity.vectorDigest, '');
		assert.equal(tariffSensitivityOf({...ledger, state: 'unavailable', totalUsd: null}, cheaper).amount, null);
	});

	it('does not collapse positive over zero or zero over positive into a favorable zero', () => {
		assert.deepEqual(ratioOf(0, 0), {state: 'both-zero', value: 1});
		assert.deepEqual(ratioOf(10, 0), {state: 'positive-over-zero', value: null});
		assert.deepEqual(ratioOf(0, 10), {state: 'zero-over-positive', value: 0});
		assert.deepEqual(ratioOf(5, 10), {state: 'finite', value: 0.5});
		assert.equal(ratioValueOf(10, 0), Number.POSITIVE_INFINITY);
		assert.equal(ratioValueOf(0, 10), 0);
	});

	it('includes every valid execution regardless of answer correctness', () => {
		const executions = [
			executionOf({caseId: 'case-a', treatment: 'no-index', costUsd: 1}),
			executionOf({caseId: 'case-a', treatment: 'candidate', costUsd: 0.5, correct: false}),
			executionOf({caseId: 'case-b', treatment: 'no-index', costUsd: 2}),
			executionOf({caseId: 'case-b', treatment: 'candidate', costUsd: 1, correct: false}),
		];
		const study = fixedSuiteCostStudyOf(executions, studyOptions);
		const invalid = fixedSuiteCostStudyOf(
			[...executions.slice(0, 3), executionOf({caseId: 'case-b', treatment: 'candidate', costUsd: 1, valid: false})],
			studyOptions,
		);

		assert.equal(study.state, 'exact');
		assert.equal(study.ratio.value, 0.5);
		assert.equal(study.incorrectExecutionCount, 2);
		assert.equal(study.gate.passed, true);
		assert.equal(invalid.state, 'unavailable');
		assert.match(invalid.reason ?? '', /missing paired arm/u);
	});

	it('produces deterministic paired resampling and a separate case-generalization interval', () => {
		const executions = [
			executionOf({caseId: 'case-a', treatment: 'no-index', costUsd: 1}),
			executionOf({caseId: 'case-a', treatment: 'candidate', costUsd: 0.5}),
			executionOf({caseId: 'case-b', treatment: 'no-index', costUsd: 2}),
			executionOf({caseId: 'case-b', treatment: 'candidate', costUsd: 1.2}),
		];
		const first = fixedSuiteCostStudyOf(executions, studyOptions);
		const second = fixedSuiteCostStudyOf(executions, studyOptions);

		assert.deepEqual(first, second);
		assert.equal(first.caseGeneralization.method, 'paired-case-uniform-bootstrap');
		assert.equal(first.oneSidedUpperState, 'bounded');
		assert.notEqual(first.oneSidedUpper95, null);
		assert.equal(first.twoSidedInterval95?.confidence, 0.95);
	});

	it('increases the final repetition count only from a disjoint paired pilot simulation', () => {
		const pilot = [
			{caseId: 'case-a', noIndexCostUsd: 1, candidateCostUsd: 0.5},
			{caseId: 'case-a', noIndexCostUsd: 1, candidateCostUsd: 0.5},
			{caseId: 'case-b', noIndexCostUsd: 2, candidateCostUsd: 1},
			{caseId: 'case-b', noIndexCostUsd: 2, candidateCostUsd: 1},
		];
		const sized = finalSampleSizeOf({
			campaignIds: ['pilot-a'],
			observations: pilot,
			finalCampaignId: 'final-a',
			desiredPower: 0.8,
			oneSidedAlpha: 0.05,
			simulations: 200,
			minRepetitions: 1,
			maxRepetitions: 5,
			seed: 'b'.repeat(64),
		});
		const insufficient = finalSampleSizeOf({
			campaignIds: ['pilot-a'],
			observations: pilot.map((observation) => ({...observation, candidateCostUsd: observation.noIndexCostUsd * 0.95})),
			finalCampaignId: 'final-a',
			desiredPower: 0.8,
			oneSidedAlpha: 0.05,
			simulations: 200,
			minRepetitions: 1,
			maxRepetitions: 2,
			seed: 'c'.repeat(64),
		});

		assert.equal(sized.repetitions, 1);
		assert.equal(sized.power, 1);
		assert.equal(insufficient.repetitions, 2);
		assert.match(insufficient.reason ?? '', /did not reach/u);
		assert.throws(
			() =>
				finalSampleSizeOf({
					campaignIds: ['pilot-a'],
					observations: pilot,
					finalCampaignId: 'pilot-a',
					desiredPower: 0.8,
					oneSidedAlpha: 0.05,
					simulations: 10,
					minRepetitions: 1,
					maxRepetitions: 2,
					seed: 'd'.repeat(64),
				}),
			/disjoint/u,
		);
	});

	it('report thresholds come from the frozen contract and cannot mix pre-v2 and v2 execution identities', () => {
		const metadata: ReportMetadataType = {
			campaignId: 'campaign-contract',
			schemaVersion: '1.0',
			suite: {id: EVALUATION_CONTRACT.suite.id, version: EVALUATION_CONTRACT.suite.version, hash: 'a'.repeat(64), status: 'frozen'},
			components: {harnessVersion: 11},
			claimClass: 'none',
			contract: EVALUATION_CONTRACT_PIN,
		};
		const treatments = [
			['no-index', 1],
			['candidate', 0.5],
		] as const;
		const runs: RunResultType[] = [];

		for (const caseId of Object.keys(EVALUATION_CONTRACT.suite.caseWeights)) {
			for (const [treatment, cost] of treatments) {
				const base = runOf({caseId, treatment});
				const identity = {...base.identity, contract: EVALUATION_CONTRACT_PIN};

				runs.push({...base, identity, identityDigest: hashOf(identity), providerCost: costVectorOf(cost)});
			}
		}

		const report = compare(runs, metadata);
		const legacy = runOf({caseId: 'case-a', treatment: 'no-index'});
		const {economic} = report;

		if (economic === null) {
			throw new Error('contract report is missing its economic analysis');
		}

		assert.equal(economic.contract.digest, EVALUATION_CONTRACT_DIGEST);
		assert.equal(economic.executions.valid, 36);
		assert.equal(economic.executions.incorrectIncluded, 0);
		assert.equal(economic.cost.ratio.value, 0.5);
		assert.equal(economic.cost.gate.passed, true);
		assert.equal(economic.correctness.gate.passed, true);
		assert.equal(economic.passed, true);
		assert.match(report.thresholds[0]?.name ?? '', /one-sided 95% upper bound/u);
		assert.throws(() => compare([legacy], metadata), /not bound to the campaign contract/u);
	});

	it('projects stored runs with every tool-output family and without dropping incorrect answers', () => {
		const base = runOf({success: false});
		const run = {
			...base,
			familyBytes: {...base.familyBytes, read: 1, execute: 2},
			providerCost: null,
		};
		const [execution] = economicExecutionsOf([run]);

		if (execution === undefined) {
			throw new Error('economic projection dropped the stored run');
		}

		assert.equal(execution.valid, true);
		assert.equal(execution.correct, false);
		assert.equal(execution.allToolOutputBytes, 3);
		assert.equal(execution.costState, 'unavailable');
	});
});
