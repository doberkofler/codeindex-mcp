import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {gradeOf} from './grade.ts';
import {caseOf, type CaseType} from './schema.ts';

const caseOfInput = (overrides: Record<string, unknown> = {}): CaseType =>
	caseOf({
		schemaVersion: 1,
		id: 'case-a',
		title: 'Case A',
		class: 'locate',
		tags: ['locate'],
		prompt: 'Which files define A?',
		scope: ['src/**'],
		expectedFiles: ['src/a.ts', 'src/b.ts'],
		contextFiles: ['src/context.ts'],
		forbiddenFiles: ['src/wrong.ts'],
		workflow: {maxTotalCalls: 12, requiredFirstTool: null, maxOutputBytes: 1000},
		timeoutMs: 1000,
		...overrides,
	});

const answer = (files: readonly string[], absent = false): string => JSON.stringify({files, absent});

describe('grade', () => {
	it('known-good exact answers pass and keep auditable assertions', () => {
		const result = gradeOf(caseOfInput(), answer(['src/a.ts', 'src/b.ts']));

		assert.equal(result.parsed, true);
		assert.equal(result.result, 'pass');
		assert.equal(result.success, true);
		assert.equal(result.falseAbsence, false);
		assert.deepEqual(result.missing, []);
		assert.deepEqual(result.forbidden, []);
		assert.deepEqual(result.extra, []);
		assert.equal(result.reason, 'all expected files named');
		assert.ok(result.assertions.some((assertion) => assertion.id === 'files.expected' && assertion.result === 'pass'));
	});

	it('missing expected files fail', () => {
		const result = gradeOf(caseOfInput(), answer(['src/a.ts']));

		assert.equal(result.result, 'fail');
		assert.equal(result.success, false);
		assert.deepEqual(result.missing, ['src/b.ts']);
		assert.match(result.reason, /missing 1 expected file/u);
	});

	it('forbidden files fail even when the expected set is complete', () => {
		const result = gradeOf(caseOfInput(), answer(['src/a.ts', 'src/b.ts', 'src/wrong.ts']));

		assert.equal(result.result, 'fail');
		assert.deepEqual(result.forbidden, ['src/wrong.ts']);
		assert.match(result.reason, /forbidden/u);
	});

	it('extra files fail unless declared as bounded context', () => {
		const rejected = gradeOf(caseOfInput(), answer(['src/a.ts', 'src/b.ts', 'src/other.ts']));
		const accepted = gradeOf(caseOfInput(), answer(['src/a.ts', 'src/b.ts', 'src/context.ts']));

		assert.equal(rejected.result, 'fail');
		assert.deepEqual(rejected.extra, ['src/other.ts']);
		assert.equal(accepted.result, 'pass');
		assert.deepEqual(accepted.extra, []);
	});

	it('repository-relative paths are normalized exactly, not matched by suffix', () => {
		const normalized = gradeOf(caseOfInput(), answer(['./src/a.ts', String.raw`src\b.ts`]));
		const prefixed = gradeOf(caseOfInput(), answer(['repo/src/a.ts', 'src/b.ts']));

		assert.equal(normalized.result, 'pass');
		assert.equal(prefixed.result, 'fail');
		assert.deepEqual(prefixed.missing, ['src/a.ts']);
	});

	it('duplicate paths do not create extra files', () => {
		const result = gradeOf(caseOfInput(), answer(['src/a.ts', 'src/a.ts', 'src/b.ts']));

		assert.equal(result.result, 'pass');
		assert.deepEqual(result.files, ['src/a.ts', 'src/b.ts']);
	});

	it('malformed, missing, and wrong-typed answers fail with a reason', () => {
		const cases = [
			['plain prose without an object', /did not contain a JSON object/u],
			['{"files": [}', /did not parse/u],
			['{"files": "src/a.ts", "absent": false}', /not an array of strings/u],
			['{"files": ["src/a.ts", "src/b.ts"]}', /"absent" was not a boolean/u],
		] as const;

		for (const [text, reason] of cases) {
			const result = gradeOf(caseOfInput(), text);

			assert.equal(result.result, 'fail');
			assert.equal(result.parsed, false);
			assert.match(result.reason, reason);
		}
	});

	it('claimed absence fails for a case with expected files', () => {
		const result = gradeOf(caseOfInput(), answer([], true));

		assert.equal(result.result, 'fail');
		assert.equal(result.falseAbsence, true);
		assert.match(result.reason, /claimed absence/u);
	});

	it('absence is inconsistent when the same answer names files', () => {
		const result = gradeOf(caseOfInput(), answer(['src/a.ts'], true));

		assert.equal(result.result, 'fail');
		assert.equal(result.assertions.find((assertion) => assertion.id === 'answer.absence-consistency')?.result, 'fail');
		assert.match(result.reason, /while naming files/u);
	});
});
