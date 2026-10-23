import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, it} from 'vitest';
import {EVALUATION_CONTRACT_PIN, TARIFF_SNAPSHOT} from './economicContract.ts';
import {runOf, surfaceOf} from './localTestSupport.ts';
import {pilotDesignOf} from './pilotDesign.ts';
import {pilotPlanOf} from './pilotPlan.ts';
import {pilotReportOf} from './pilotAnalysis.ts';
import {reconcileProviderMeterLedger, type ProviderRequestLedgerEntryType} from './providerMeterLedger.ts';
import {presentedToolsOf} from './surface.ts';
import {type ProviderTokenUsageType} from './providerUsage.ts';
import {type RunResultType} from './runTypes.ts';
import {taskCostVectorOf} from './taskCost.ts';

const designPath = path.resolve(import.meta.dirname, '../../pilots/ab-development-v1.json');
const design = pilotDesignOf(JSON.parse(readFileSync(designPath, 'utf8')) as unknown);

const usageOf = (): ProviderTokenUsageType => ({
	nonCachedInputTokens: 100,
	cacheReadTokens: 10,
	cacheWriteTokens: {},
	visibleOutputTokens: 20,
	reasoningTokens: 5,
	reportedCostUsd: null,
	missingFields: [],
	invalidFields: [],
	complete: true,
});

const requestsOf = (tools: readonly string[]): readonly ProviderRequestLedgerEntryType[] => [
	{
		ordinal: 1,
		kind: 'agent',
		provider: 'deepseek',
		model: 'deepseek-flash',
		startedAt: '2026-10-23T12:00:00.000Z',
		completedAt: '2026-10-23T12:00:01.000Z',
		toolNames: tools,
		requestBytes: 100,
		responseBytes: 100,
		settlement: {status: 'completed', usage: usageOf()},
	},
];

const meteredRunOf = (treatment: 'no-index' | 'candidate', success: boolean, indexAuthoritative: boolean): RunResultType => {
	const tools = presentedToolsOf(surfaceOf(treatment));
	const run = runOf({treatment, success, retrievalBytes: 100});
	const ledger = {recordType: 'provider-meter' as const, provider: 'deepseek', requests: requestsOf(tools)};
	const providerMeter = reconcileProviderMeterLedger(ledger);
	const providerCost = taskCostVectorOf(ledger, TARIFF_SNAPSHOT);
	const [firstCall] = run.toolCalls;

	if (firstCall === undefined) {
		throw new Error('test fixture has no tool call');
	}

	const indexCall: RunResultType['toolCalls'][number] = {
		...firstCall,
		tool: 'codeindex_find_symbol',
		family: 'index',
		authoritative: indexAuthoritative,
		outputBytes: 80,
	};

	return {
		...run,
		providerMeter,
		providerCost,
		surface: surfaceOf(treatment),
		toolCalls: treatment === 'candidate' ? [indexCall, ...run.toolCalls.slice(1)] : run.toolCalls,
		indexCalls: treatment === 'candidate' ? 1 : 0,
		workflow: {...run.workflow, fallbacksAfterAuthoritative: indexAuthoritative ? 0 : 1},
	};
};

describe('development pilot design', () => {
	it('loads the frozen design and reproduces the accepted contract pin', () => {
		assert.equal(design.id, 'ab-development-v1');
		assert.equal(design.contract.digest, EVALUATION_CONTRACT_PIN.digest);
		assert.equal(design.exposure.selected, 'direct-mcp');
		assert.equal(design.holdout.execution, 'not-run');
		assert.equal(design.cases.length, 6);
		assert.ok(design.cases.every((testCase) => !design.holdout.caseIds.includes(testCase.id)));
	});

	it('rejects a case-weight change after the freeze', () => {
		const tampered = JSON.parse(readFileSync(designPath, 'utf8')) as Record<string, unknown>;
		const cases = tampered['cases'] as Record<string, unknown>[];
		cases[0] = {...cases[0], weight: 0.5};

		assert.throws(() => pilotDesignOf(tampered), /weights must sum|frozen contract weight/u);
	});

	it('rejects holdout reuse by the development arm', () => {
		const tampered = JSON.parse(readFileSync(designPath, 'utf8')) as Record<string, unknown>;
		const holdout = tampered['holdout'] as Record<string, unknown>;
		holdout['caseIds'] = [...(holdout['caseIds'] as string[]), 'locate-schema-version'];

		assert.throws(() => pilotDesignOf(tampered), /holdout cases must be disjoint/u);
	});
});

describe('development pilot plan', () => {
	it('is deterministic and pairs both treatments for every repetition', () => {
		const plan = pilotPlanOf(design.cases, design.repetitions, design.seed);
		const repeated = pilotPlanOf(design.cases, design.repetitions, design.seed);

		assert.deepEqual(plan, repeated);
		assert.equal(plan.plan.length, design.cases.length * design.repetitions * 2);

		for (const testCase of design.cases) {
			const entries = plan.plan.filter((entry) => entry.caseId === testCase.id);

			assert.equal(entries.filter((entry) => entry.treatment === 'no-index').length, design.repetitions);
			assert.equal(entries.filter((entry) => entry.treatment === 'candidate').length, design.repetitions);
		}
	});
});

describe('development pilot analysis', () => {
	it('classifies request-1 availability, index contribution, and authoritative stop', () => {
		const report = pilotReportOf({
			runs: [meteredRunOf('no-index', true, false), meteredRunOf('candidate', true, true)],
			design,
			generatedAt: '2026-10-23T12:00:00.000Z',
		});
		const candidate = report.trajectories.find((trajectory) => trajectory.treatment === 'candidate');
		const baseline = report.trajectories.find((trajectory) => trajectory.treatment === 'no-index');

		assert.ok(candidate !== undefined);
		assert.ok(baseline !== undefined);
		assert.equal(candidate.requestOne.state, 'present');
		assert.deepEqual(candidate.requestOne.codeIndexTools, ['codeindex_find_symbol']);
		assert.deepEqual(baseline.requestOne.codeIndexTools, []);
		assert.equal(candidate.index.indexContribution, 'authoritative');
		assert.equal(candidate.index.authoritativeStop, 'authoritative-stop');
		assert.equal(report.trajectorySummary.find((summary) => summary.treatment === 'candidate')?.authoritativeStops, 1);
	});

	it('classifies the first agent request when an auxiliary request precedes it', () => {
		const base = meteredRunOf('candidate', true, true);
		const [first] = requestsOf(presentedToolsOf(surfaceOf('candidate')));

		assert.ok(first !== undefined);
		const providerMeter = reconcileProviderMeterLedger({
			recordType: 'provider-meter',
			provider: 'deepseek',
			requests: [
				{...first, ordinal: 1, kind: 'other', toolNames: []},
				{...first, ordinal: 2, kind: 'agent'},
			],
		});
		const report = pilotReportOf({runs: [meteredRunOf('no-index', true, false), {...base, providerMeter}], design, generatedAt: '2026-10-23T12:00:00.000Z'});
		const candidate = report.trajectories.find((trajectory) => trajectory.treatment === 'candidate');

		assert.ok(candidate !== undefined);
		assert.equal(candidate.requestOne.state, 'present');
		assert.equal(candidate.requestOne.kind, 'agent');
	});

	it('makes no release claim and stops when a cost vector is incomplete', () => {
		const complete = meteredRunOf('candidate', true, true);
		const incomplete = {...meteredRunOf('no-index', true, false), providerCost: null};
		const report = pilotReportOf({runs: [incomplete, complete], design, generatedAt: '2026-10-23T12:00:00.000Z'});

		assert.equal(report.releaseAuthority, false);
		assert.equal(report.efficacyClaim, false);
		assert.equal(report.decision.decision, 'stop');
	});
});
