import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {EVALUATION_CONTRACT_PIN, TARIFF_SNAPSHOT} from './economicContract.ts';
import {exposureDesignOf, type ExposureDesignType} from './exposureDesign.ts';
import {exposurePlanOf} from './exposurePlan.ts';
import {hashOf} from './hash.ts';

const designOf = (overrides: Record<string, unknown> = {}): ExposureDesignType => {
	const base = {
		recordType: 'exposure-comparison-design',
		schemaVersion: 1,
		id: 'direct-vs-code-mode-v1',
		status: 'frozen',
		frozenAt: '2026-10-25T00:00:00.000Z',
		contract: {id: 'evaluation-validity-v2', version: 2, digest: EVALUATION_CONTRACT_PIN.digest},
		suite: {
			id: 'codeindex-exposure',
			path: 'suites/exposure.json',
			version: 1,
			hash: 'a'.repeat(64),
			revision: 'abc1234',
		},
		exposure: {baseline: 'direct-mcp', treatment: 'code-mode', rationale: 'same artifact'},
		model: {
			provider: 'deepseek',
			modelId: 'deepseek-flash',
			reference: 'deepseek/deepseek-flash',
			runtime: '2.1.4',
			generation: {temperature: null, topP: null, topK: null, repeatPenalty: null, stop: []},
		},
		artifact: {id: 'candidate', digest: 'b'.repeat(64)},
		ordinaryTools: ['bash', 'glob', 'grep', 'read'],
		cases: [{id: 'case-a', class: 'impact'}],
		repetitions: 2,
		seed: 'seed',
		tariff: {id: TARIFF_SNAPSHOT.id, source: TARIFF_SNAPSHOT.source, retrievedAt: TARIFF_SNAPSHOT.retrievedAt, digest: hashOf(TARIFF_SNAPSHOT)},
		route: {
			suiteId: 'codeindex-release',
			path: 'routes/codeindex-release.json',
			version: 1,
			hash: 'c'.repeat(64),
			plan: 'routes/codeindex-release.json',
			planHash: 'd'.repeat(64),
		},
		frozenProduction: {exposure: 'direct-mcp', certification: 'reports/certification-eval-037.json', certificationDigest: 'e'.repeat(64)},
		budget: {maxExecutions: 8, maxWallClockMs: 60_000, maxProviderCostUsd: 1},
		thresholds: {confidence: 0.95, minimumCostSaving: 0.05, nonInferiorityMargin: 0.02, falseAbsenceTolerance: 0},
		decisionPolicy: {retainDirect: 'keep', adoptCodeMode: 'reopen', inconclusive: 'blocked'},
		...overrides,
	};
	const digest = hashOf(base);

	return exposureDesignOf({...base, digest});
};

describe('exposure design and plan', () => {
	it('freezes one artifact and both exposure arms', () => {
		const design = designOf();

		assert.equal(design.exposure.baseline, 'direct-mcp');
		assert.equal(design.exposure.treatment, 'code-mode');
		assert.equal(design.artifact.id, 'candidate');
		assert.equal(design.thresholds.minimumCostSaving, 0.05);
	});

	it('rejects a design changed after its digest', () => {
		const design = designOf();
		const changed = {...design, repetitions: 3};

		assert.throws(() => exposureDesignOf(changed), /digest does not match/u);
	});

	it('builds randomized direct/Code-Mode pairs without losing a slot', () => {
		const design = designOf();
		const plan = exposurePlanOf(design.cases, design.repetitions, design.seed);

		assert.equal(plan.plan.length, design.cases.length * design.repetitions * 2);
		assert.equal(new Set(plan.plan.map((entry) => `${entry.caseId}/${entry.treatment}/${entry.repetition}`)).size, plan.plan.length);
		assert.deepEqual(
			plan.plan
				.filter((entry) => entry.repetition === 1)
				.map((entry) => entry.treatment)
				.sort(),
			['code-mode', 'direct-mcp'],
		);
	});
});
