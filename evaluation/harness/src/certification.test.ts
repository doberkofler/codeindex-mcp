import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, it} from 'vitest';
import {certificationBlockReportOf} from './certificationBlock.ts';
import {certificationDesignOf, type CertificationBlockType, type CertificationDesignType} from './certificationDesign.ts';
import {certificationPlanOf} from './certificationPlan.ts';
import {certificationReportOf, type CertificationRouteEvidenceType} from './certificationReport.ts';
import {EVALUATION_CONTRACT_PIN, TARIFF_SNAPSHOT} from './economicContract.ts';
import {runOf, surfaceOf} from './localTestSupport.ts';
import {reconcileProviderMeterLedger, type ProviderRequestLedgerEntryType} from './providerMeterLedger.ts';
import {type ProviderTokenUsageType} from './providerUsage.ts';
import {type RunResultType} from './runTypes.ts';
import {presentedToolsOf} from './surface.ts';
import {taskCostVectorOf} from './taskCost.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const designPath = path.resolve(import.meta.dirname, '../../certifications/impact-certification-v1.json');
const rawDesign = JSON.parse(readFileSync(designPath, 'utf8')) as Record<string, unknown>;
const design = certificationDesignOf(rawDesign);

const blockOf = (id: 'primary' | 'holdout', cases: readonly string[], repetitions: number): CertificationBlockType => ({
	id,
	role: id === 'primary' ? 'confirmatory' : 'descriptive',
	suite: design.blocks[id === 'primary' ? 0 : 1]?.suite ?? design.blocks[0]?.suite ?? {id: '', path: '', version: 0, hash: '', revision: ''},
	cases: cases.map((caseId) => ({
		id: caseId,
		class: id === 'primary' ? 'impact' : 'locate',
		weight: 1 / cases.length,
	})),
	repetitions,
});

type ArmType = 'no-index' | 'candidate';

const armOf = (treatment: string): ArmType => (treatment === 'no-index' ? 'no-index' : 'candidate');

const usageOf = (treatment: ArmType): ProviderTokenUsageType => {
	const candidate = treatment === 'candidate';

	return {
		nonCachedInputTokens: candidate ? 50 : 100,
		cacheReadTokens: candidate ? 5 : 10,
		cacheWriteTokens: {},
		visibleOutputTokens: candidate ? 10 : 20,
		reasoningTokens: 0,
		reportedCostUsd: null,
		missingFields: [],
		invalidFields: [],
		complete: true,
	};
};

const ledgerRequestOf = (treatment: ArmType, toolNames: readonly string[]): ProviderRequestLedgerEntryType => ({
	ordinal: 1,
	kind: 'agent',
	provider: 'deepseek',
	model: 'deepseek-flash',
	startedAt: '2026-10-23T12:00:00.000Z',
	completedAt: '2026-10-23T12:00:01.000Z',
	toolNames,
	requestBytes: 100,
	responseBytes: 100,
	settlement: {status: 'completed', usage: usageOf(treatment)},
});

const ledgerOf = (treatment: ArmType): readonly ProviderRequestLedgerEntryType[] => [ledgerRequestOf(treatment, presentedToolsOf(surfaceOf(treatment)))];

const meteredRunOf = (input: Readonly<{caseId: string; treatment: ArmType; repetition: number; design: CertificationDesignType}>): RunResultType => {
	const ledger = {recordType: 'provider-meter' as const, provider: 'deepseek', requests: ledgerOf(input.treatment)};
	const run = runOf({caseId: input.caseId, caseClass: 'impact', treatment: input.treatment, repetition: input.repetition, success: true});

	return {
		...run,
		model: input.design.model.reference,
		providerMeter: reconcileProviderMeterLedger(ledger),
		providerCost: taskCostVectorOf(ledger, TARIFF_SNAPSHOT),
		timeoutMs: input.design.thresholds.timeoutCeilingMs,
		artifacts: {
			accepted: {id: input.design.artifacts.accepted.id, digest: input.design.artifacts.accepted.digest},
			candidate: {id: input.design.artifacts.candidate.id, digest: input.design.artifacts.candidate.digest},
			loaded: input.treatment === 'no-index' ? null : {id: input.design.artifacts.candidate.id, digest: input.design.artifacts.candidate.digest},
		},
	};
};

const runsOf = (block: CertificationBlockType, target = design): readonly RunResultType[] => {
	const plan = certificationPlanOf(block, target.digest);

	return plan.plan.map((entry) => meteredRunOf({caseId: entry.caseId, treatment: armOf(entry.treatment), repetition: entry.repetition, design: target}));
};

const routeOf = (): CertificationRouteEvidenceType => ({
	reportDigest: 'a'.repeat(64),
	generatedAt: '2026-10-23T14:00:00.000Z',
	suite: {
		id: design.route.suiteId,
		version: design.route.suiteVersion,
		hash: design.route.suiteHash,
		revision: design.subject.revision,
	},
	plan: {id: 'codeindex-release-model-free', hash: design.route.planHash},
	artifacts: {accepted: design.artifacts.accepted, candidate: design.artifacts.candidate},
	gates: [
		{id: 'G-E1a', result: 'pass', detail: 'exact'},
		{id: 'G-E1b', result: 'pass', detail: 'measured'},
		{id: 'G-E1c', result: 'pass', detail: 'probed'},
	],
	presentedGates: 3,
	contractProbes: {accepted: 4, candidate: 4},
	passed: true,
});

describe('frozen certification design', () => {
	it('binds both artifacts, the subject, contract, tariff, and route gate', () => {
		assert.equal(design.id, 'impact-certification-v1');
		assert.equal(design.contract.digest, EVALUATION_CONTRACT_PIN.digest);
		assert.equal(design.exposure.selected, 'direct-mcp');
		const [primaryBlock, holdoutBlock] = design.blocks;

		assert.ok(primaryBlock !== undefined);
		assert.ok(holdoutBlock !== undefined);
		assert.equal(primaryBlock.id, 'primary');
		assert.equal(holdoutBlock.id, 'holdout');
		assert.ok(primaryBlock.cases.every((testCase) => testCase.class === 'impact'));
		assert.equal(design.sampleSize.caseCount, primaryBlock.cases.length);
		assert.equal(design.sampleSize.repetitions, primaryBlock.repetitions);
	});

	it('rejects a post-freeze case weight change', () => {
		const tampered = structuredClone(rawDesign);
		const {blocks} = tampered;
		assert.ok(Array.isArray(blocks));
		const [primary] = blocks;
		assert.ok(isRecord(primary));
		const {cases} = primary;
		assert.ok(Array.isArray(cases));
		const [first] = cases;
		assert.ok(isRecord(first));
		first['weight'] = 0.5;

		assert.throws(() => certificationDesignOf(tampered), /weights must sum|frozen contract weight/u);
	});

	it('rejects a post-freeze threshold change', () => {
		const tampered = structuredClone(rawDesign);
		const {thresholds} = tampered;
		assert.ok(isRecord(thresholds));
		thresholds['costRatioTarget'] = 0.95;

		assert.throws(() => certificationDesignOf(tampered), /cost target/u);
	});

	it('rejects a primary case outside the impact class', () => {
		const tampered = structuredClone(rawDesign);
		const {blocks} = tampered;
		assert.ok(Array.isArray(blocks));
		const [primary] = blocks;
		assert.ok(isRecord(primary));
		const {cases} = primary;
		assert.ok(Array.isArray(cases));
		const [first] = cases;
		assert.ok(isRecord(first));
		first['class'] = 'locate';

		assert.throws(() => certificationDesignOf(tampered), /only impact-class/u);
	});
});

describe('certification plan', () => {
	it('is deterministic and pairs both arms for every frozen repetition', () => {
		const [block] = design.blocks;

		assert.ok(block !== undefined);
		const plan = certificationPlanOf(block, design.digest);
		const repeated = certificationPlanOf(block, design.digest);

		assert.deepEqual(plan, repeated);
		assert.equal(plan.plan.length, design.sampleSize.caseCount * design.sampleSize.repetitions * 2);

		for (const testCase of block.cases) {
			const entries = plan.plan.filter((entry) => entry.caseId === testCase.id);

			assert.equal(entries.filter((entry) => entry.treatment === 'no-index').length, block.repetitions);
			assert.equal(entries.filter((entry) => entry.treatment === 'candidate').length, block.repetitions);
		}
	});
});

describe('certification block analysis', () => {
	it('reports exact metering, request-1 surface, token components, and the paired cost gate', () => {
		const block = blockOf('primary', ['impact-a', 'impact-b'], 1);
		const plan = certificationPlanOf(block, design.digest);
		const report = certificationBlockReportOf({block, plan, runs: runsOf(block), design});

		assert.equal(report.reliability.validExecutions, 4);
		assert.equal(report.reliability.exactMetering, 4);
		assert.equal(report.reliability.requestOnePresent, 4);
		assert.equal(report.economic.cost.gate.passed, true);
		assert.equal(report.economic.correctness.gate.passed, true);
		assert.equal(report.economic.correctness.falseAbsenceCount, 0);
		assert.ok((report.economic.cost.ratio.value ?? Number.POSITIVE_INFINITY) < 0.9);
		assert.ok(report.tokens.every((token) => token.components !== null));
		assert.equal(report.passed, true);
	});

	it('retains a missing execution as a closed invalid slot', () => {
		const block = blockOf('primary', ['impact-a', 'impact-b'], 1);
		const plan = certificationPlanOf(block, design.digest);
		const runs = runsOf(block).slice(0, 3);
		const report = certificationBlockReportOf({block, plan, runs, design});

		assert.equal(report.reliability.validExecutions, 3);
		assert.equal(report.reliability.invalidExecutions, 1);
		assert.match(report.blocking.join(' '), /missing-execution/u);
		assert.equal(report.passed, false);
	});

	it('closes incomplete metering and request-1 mismatch as invalid causes', () => {
		const block = blockOf('primary', ['impact-a', 'impact-b'], 1);
		const plan = certificationPlanOf(block, design.digest);
		const runs = runsOf(block).map((run, index) =>
			index === 0
				? {...run, providerCost: null}
				: index === 1
					? {
							...run,
							providerMeter: reconcileProviderMeterLedger({
								recordType: 'provider-meter',
								provider: 'deepseek',
								requests: [ledgerRequestOf(armOf(run.treatment), [])],
							}),
						}
					: run,
		);
		const report = certificationBlockReportOf({block, plan, runs, design});
		const causes = new Set(report.trajectories.flatMap((trajectory) => trajectory.causes));

		assert.ok(causes.has('incomplete-metering'));
		assert.ok(causes.has('request-1-surface-mismatch'));
		assert.equal(report.passed, false);
	});

	it('closes path contamination and unknown tools as invalid causes', () => {
		const block = blockOf('primary', ['impact-a', 'impact-b'], 1);
		const plan = certificationPlanOf(block, design.digest);
		const runs = runsOf(block).map((run, index) =>
			index === 0 ? {...run, externalPathAttemptCount: 1} : index === 1 ? {...run, routing: {...run.routing, unknownTools: ['mystery']}} : run,
		);
		const report = certificationBlockReportOf({block, plan, runs, design});
		const causes = new Set(report.trajectories.flatMap((trajectory) => trajectory.causes));

		assert.ok(causes.has('path-contamination'));
		assert.ok([...causes].some((cause) => cause.startsWith('unknown-tools:')));
		assert.equal(report.passed, false);
	});
});

describe('certification decision', () => {
	it('records not-release when a zero-spend or route gate is absent', () => {
		const report = certificationReportOf({
			design,
			preflightGates: [{id: 'frozen-design', passed: true, detail: 'frozen'}],
			route: null,
			blocks: [],
		});

		assert.equal(report.decision.decision, 'not-release');
		assert.equal(report.releaseAuthority, false);
		assert.ok(report.decision.blocking.some((item) => item.startsWith('model-free-route:')));
	});

	it('records release only when both blocks and the route gate pass', () => {
		const primary = blockOf('primary', ['impact-a', 'impact-b'], 1);
		const holdout = blockOf('holdout', ['holdout-a'], 1);
		const report = certificationReportOf({
			design,
			preflightGates: [{id: 'frozen-design', passed: true, detail: 'frozen'}],
			route: routeOf(),
			blocks: [
				{block: primary, plan: certificationPlanOf(primary, design.digest), runs: runsOf(primary)},
				{block: holdout, plan: certificationPlanOf(holdout, design.digest), runs: runsOf(holdout)},
			],
		});

		assert.equal(report.decision.decision, 'release');
		assert.equal(report.releaseAuthority, true);
		assert.equal(report.primary?.claimAuthority, 'release-gate');
		assert.equal(report.holdout?.claimAuthority, 'descriptive');
	});
});
