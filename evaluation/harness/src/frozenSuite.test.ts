import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {caseHashOf} from './schema.ts';
import {loadSuite, planOf, selectCases} from './suite.ts';

const EVALUATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_PATH = path.join(EVALUATION_ROOT, 'suites', 'release.json');
const CALIBRATION_PATH = path.join(EVALUATION_ROOT, 'suites', 'calibration.json');

const classCountsOf = (classes: readonly string[]): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {locate: 0, impact: 0, semantic: 0, implementation: 0};

	for (const item of classes) {
		counts[item] = (counts[item] ?? 0) + 1;
	}

	return counts;
};

test('release suite is frozen at 18 cases and four task classes', () => {
	const {suite, cases} = loadSuite(RELEASE_PATH);
	const pinned = suite.caseHashes;

	assert.equal(suite.status, 'frozen');
	assert.equal(suite.version, 1);
	assert.equal(suite.repetitions, 5);
	assert.match(suite.revision, /^[0-9a-f]{40}$/u);
	assert.equal(suite.cases.length, 18);
	assert.equal(new Set(suite.cases).size, 18);
	assert.deepEqual(classCountsOf(cases.map((testCase) => testCase.class)), {
		locate: 4,
		impact: 6,
		semantic: 6,
		implementation: 2,
	});
	assert.notEqual(pinned, null);

	for (const testCase of cases) {
		assert.equal(pinned?.[testCase.id], caseHashOf(testCase));
	}
});

test('calibration suite is a frozen six-case subset with twelve smoke executions', () => {
	const {suite, cases} = loadSuite(CALIBRATION_PATH);
	const release = loadSuite(RELEASE_PATH);
	const pinned = suite.caseHashes;

	assert.equal(suite.status, 'frozen');
	assert.equal(suite.version, 1);
	assert.equal(suite.repetitions, 1);
	assert.equal(suite.revision, release.suite.revision);
	assert.equal(suite.cases.length, 6);
	assert.deepEqual(classCountsOf(cases.map((testCase) => testCase.class)), {
		locate: 1,
		impact: 2,
		semantic: 2,
		implementation: 1,
	});
	assert.notEqual(pinned, null);

	for (const testCase of cases) {
		assert.equal(pinned?.[testCase.id], caseHashOf(testCase));
		assert.ok(release.suite.cases.includes(testCase.id));
	}

	assert.equal(planOf(selectCases(cases, {}), ['no-index', 'accepted'], 1).length, 12);
});
