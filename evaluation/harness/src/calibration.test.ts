import assert from 'node:assert/strict';
import test from 'node:test';
import {
	calibrationDecisionOf,
	calibrationDisqualificationOf,
	calibrationSelectionOf,
	type CalibrationDecisionType,
	type CalibrationExecutionType,
	type CalibrationMetricType,
} from './calibration.ts';

const CASES = ['locate-a', 'impact-a', 'impact-b', 'semantic-a', 'semantic-b', 'impl-a'] as const;
const BUDGET_MS = 900_000;

const exactToken = (value: number): CalibrationMetricType => ({value, state: 'exact'});

const runOf = (
	overrides: Readonly<{
		caseId: string;
		treatment: 'no-index' | 'accepted';
		success?: boolean;
		durationMs?: number;
		attempts?: readonly unknown[];
		timedOut?: boolean;
		tokens?: 'exact' | 'unavailable';
	}>,
): CalibrationExecutionType => {
	const success = overrides.success ?? true;
	const tokens = overrides.tokens ?? 'exact';
	const token = tokens === 'exact' ? exactToken(10) : {value: null, state: 'unavailable' as const};

	return {
		caseId: overrides.caseId,
		treatment: overrides.treatment,
		repetition: 1,
		valid: overrides.timedOut !== true,
		defects: [],
		outcome: overrides.timedOut === true ? 'timed-out' : 'completed',
		timedOut: overrides.timedOut ?? false,
		invalidReason: overrides.timedOut === true ? 'timed out' : null,
		isolation: {restored: true},
		attempts: overrides.attempts ?? [{}],
		grade: {success},
		telemetry: {inputTokens: token, outputTokens: token, reasoningTokens: token},
		usage: {available: tokens === 'exact', input: 10, output: 5, reasoning: 1},
		durationMs: overrides.durationMs ?? 10_000,
		familyBytes: {index: 0, search: 0, read: 100, list: 0},
		toolCalls: [{}],
	};
};

const calibrationOf = (
	overrides: Readonly<{
		results?: readonly CalibrationExecutionType[];
		elapsedMs?: number;
		budgetMs?: number;
	}> = {},
): ReturnType<typeof calibrationDecisionOf> => {
	const results = overrides.results ?? CASES.flatMap((caseId) => [runOf({caseId, treatment: 'no-index'}), runOf({caseId, treatment: 'accepted'})]);

	return calibrationDecisionOf({
		model: 'ollama/qwen3.8:27b-mlx',
		environmentId: 'ollama-qwen3.8-27b-calibration',
		environmentHash: 'a'.repeat(64),
		budgetMs: overrides.budgetMs ?? BUDGET_MS,
		elapsedMs: overrides.elapsedMs ?? 600_000,
		plannedSlots: 12,
		results,
	});
};

const decisionOf = (overrides: Partial<CalibrationDecisionType>): CalibrationDecisionType => ({
	model: 'ollama/model-a',
	environment: {id: 'environment-a', hash: 'b'.repeat(64)},
	budgetMs: BUDGET_MS,
	elapsedMs: 1000,
	plannedSlots: 12,
	executedSlots: 12,
	validExecutions: 12,
	noIndexExact: 6,
	acceptedExact: 6,
	correctnessLossCases: [],
	interventions: [],
	telemetry: {tokenState: 'exact', limitation: null},
	acceptedMedianWallMs: 10_000,
	acceptedMedianRetrievalBytes: 100,
	acceptedMedianToolCalls: 1,
	passed: true,
	disqualification: null,
	...overrides,
});

void test('twelve valid executions inside the budget qualify a model', () => {
	const decision = calibrationOf();

	assert.equal(decision.passed, true);
	assert.equal(decision.validExecutions, 12);
	assert.equal(decision.executedSlots, 12);
	assert.equal(decision.noIndexExact, 6);
	assert.equal(decision.acceptedExact, 6);
	assert.equal(decision.telemetry.tokenState, 'exact');
	assert.equal(decision.disqualification, null);
});

void test('a case that loses accepted correctness disqualifies the model', () => {
	const lossy = CASES.flatMap((caseId) => [runOf({caseId, treatment: 'no-index'}), runOf({caseId, treatment: 'accepted', success: caseId !== 'semantic-a'})]);
	const decision = calibrationOf({results: lossy});

	assert.equal(decision.passed, false);
	assert.deepEqual(decision.correctnessLossCases, ['semantic-a']);
	assert.match(decision.disqualification ?? '', /correctness loss on semantic-a/u);
});

void test('a retry or timeout is an intervention, never a quiet pass', () => {
	const retried = CASES.flatMap((caseId) => [runOf({caseId, treatment: 'no-index'}), runOf({caseId, treatment: 'accepted', attempts: [{}, {}]})]);
	const timedOut = CASES.flatMap((caseId) => [
		runOf({caseId, treatment: 'no-index'}),
		runOf({caseId, treatment: 'accepted', timedOut: caseId === 'semantic-a'}),
	]);

	assert.equal(calibrationOf({results: retried}).passed, false);
	assert.equal(calibrationOf({results: retried}).interventions.length > 0, true);
	assert.equal(calibrationOf({results: timedOut}).passed, false);
	assert.match(calibrationOf({results: timedOut}).disqualification ?? '', /interventions required/u);
});

void test('budget overrun and incomplete executions both disqualify', () => {
	const overrun = calibrationOf({elapsedMs: BUDGET_MS + 1});
	const incomplete = calibrationOf({results: [runOf({caseId: 'locate-a', treatment: 'accepted'})]});

	assert.equal(overrun.passed, false);
	assert.match(overrun.disqualification ?? '', /budget exceeded/u);
	assert.equal(incomplete.passed, false);
	assert.match(incomplete.disqualification ?? '', /incomplete: 1\/12/u);
});

void test('missing token usage limits the claim without invalidating correctness', () => {
	const decision = calibrationOf({
		results: CASES.flatMap((caseId) => [
			runOf({caseId, treatment: 'no-index'}),
			runOf({caseId, treatment: 'accepted', tokens: caseId === 'impact-a' ? 'unavailable' : 'exact'}),
		]),
	});

	assert.equal(decision.telemetry.tokenState, 'unavailable');
	assert.match(decision.telemetry.limitation ?? '', /token metrics are invalid/u);
	assert.equal(decision.passed, true);
});

void test('selection prefers qualifiers, exactness, then latency and bytes', () => {
	const slowExact = decisionOf({model: 'ollama/slow', acceptedExact: 6, acceptedMedianWallMs: 20_000});
	const fastExact = decisionOf({model: 'ollama/fast', acceptedExact: 6, acceptedMedianWallMs: 10_000});
	const lessExact = decisionOf({model: 'ollama/less', acceptedExact: 5, acceptedMedianWallMs: 1000});
	const disqualified = decisionOf({model: 'ollama/bad', passed: false});

	const selection = calibrationSelectionOf([slowExact, disqualified, lessExact, fastExact]);

	assert.equal(selection.selected, 'ollama/fast');
	assert.deepEqual(selection.qualified, ['ollama/fast', 'ollama/slow', 'ollama/less']);
	assert.match(selection.reason, /lowest accepted median wall time/u);
});

void test('an unexecuted candidate is recorded instead of disappearing', () => {
	const excluded = calibrationDisqualificationOf({
		model: 'ollama/devstral-small-2:latest',
		environmentId: 'ollama-devstral-small-2-calibration',
		environmentHash: 'b'.repeat(64),
		budgetMs: BUDGET_MS,
		plannedSlots: 12,
		reason: 'excluded before execution: model is too large for the reference machine',
	});

	assert.equal(excluded.passed, false);
	assert.equal(excluded.executedSlots, 0);
	assert.equal(excluded.validExecutions, 0);
	assert.equal(excluded.plannedSlots, 12);
	assert.match(excluded.disqualification ?? '', /excluded before execution/u);
	assert.equal(calibrationSelectionOf([decisionOf({model: 'ollama/fast'}), excluded]).selected, 'ollama/fast');
	assert.equal(calibrationSelectionOf([excluded]).selected, null);
});

void test('selection records that no model qualified', () => {
	const selection = calibrationSelectionOf([decisionOf({passed: false})]);

	assert.equal(selection.selected, null);
	assert.deepEqual(selection.qualified, []);
});
