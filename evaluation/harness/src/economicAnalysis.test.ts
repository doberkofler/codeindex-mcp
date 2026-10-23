import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {type EconomicExecutionType} from './costStudy.ts';
import {pairedCorrectnessStudyOf, type CorrectnessStudyType} from './economicAnalysis.ts';

const executionOf = (caseId: string, treatment: 'no-index' | 'candidate', correct: boolean, repetition: number): EconomicExecutionType => ({
	caseId,
	caseClass: 'impact',
	treatment,
	repetition,
	valid: true,
	correct,
	falseAbsence: false,
	timedOut: false,
	durationMs: 1,
	timeoutMs: 1,
	costUsd: 1,
	costState: 'exact',
	allToolOutputBytes: 0,
	toolOutputByFamily: {},
});

const runsOf = (baselineCorrect: number, candidateCorrect: number): readonly EconomicExecutionType[] => {
	const executions: EconomicExecutionType[] = [];

	for (let repetition = 1; repetition <= 20; repetition += 1) {
		executions.push(
			executionOf('impact-a', 'no-index', repetition <= baselineCorrect, repetition),
			executionOf('impact-a', 'candidate', repetition <= candidateCorrect, repetition),
			executionOf('impact-b', 'no-index', true, repetition),
			executionOf('impact-b', 'candidate', true, repetition),
		);
	}

	return executions;
};

const studyOf = (baselineCorrect: number, candidateCorrect: number): CorrectnessStudyType =>
	pairedCorrectnessStudyOf(runsOf(baselineCorrect, candidateCorrect), {
		weights: {'impact-a': 0.5, 'impact-b': 0.5},
		margin: 0.02,
		confidence: 0.95,
		resamples: 500,
		seed: 'correctness-direction',
	});

describe('paired correctness non-inferiority', () => {
	it('treats a better candidate as non-inferior', () => {
		const study = studyOf(18, 20);

		assert.ok(Math.abs((study.pairedDifference ?? 0) + 0.05) < 1e-12);
		assert.equal(study.oneSidedUpper95, 0);
		assert.equal(study.gate.passed, true);
	});

	it('rejects a candidate whose upper degradation bound exceeds the margin', () => {
		const study = studyOf(20, 18);

		assert.ok(Math.abs((study.pairedDifference ?? 0) - 0.05) < 1e-12);
		assert.ok((study.oneSidedUpper95 ?? 0) > 0.02);
		assert.equal(study.gate.passed, false);
	});
});
