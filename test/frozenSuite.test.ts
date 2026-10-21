import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {caseHashOf} from '../evaluation/harness/src/schema.ts';
import {loadSuite, planOf, selectCases} from '../evaluation/harness/src/suite.ts';

const evaluationRoot = path.resolve(import.meta.dirname, '..', 'evaluation');
const releasePath = path.join(evaluationRoot, 'suites', 'release.json');
const calibrationPath = path.join(evaluationRoot, 'suites', 'calibration.json');

const classCountsOf = (classes: readonly string[]): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {
		locate: 0,
		impact: 0,
		implementation: 0,
		semantic: 0,
	};

	for (const item of classes) {
		counts[item] = (counts[item] ?? 0) + 1;
	}

	return counts;
};

describe('frozen evaluation suites', () => {
	it('freezes the 18-case release suite with every required class and pattern', () => {
		const {suite, cases} = loadSuite(releasePath);
		const pinned = suite.caseHashes;

		expect(suite.status).toBe('frozen');
		expect(suite.version).toBe(1);
		expect(suite.repetitions).toBe(5);
		expect(suite.revision).toMatch(/^[0-9a-f]{40}$/u);
		expect(suite.cases).toHaveLength(18);
		expect(new Set(suite.cases).size).toBe(18);
		expect(classCountsOf(cases.map((testCase) => testCase.class))).toStrictEqual({
			locate: 4,
			impact: 6,
			implementation: 2,
			semantic: 6,
		});

		if (pinned === null) {
			throw new Error('the release suite must pin a case hash for every case');
		}

		expect(Object.keys(pinned).sort()).toStrictEqual([...suite.cases].sort());

		for (const testCase of cases) {
			expect(pinned[testCase.id]).toBe(caseHashOf(testCase));
		}

		const semanticTags = new Set(cases.filter((testCase) => testCase.class === 'semantic').flatMap((testCase) => testCase.tags));

		for (const pattern of ['barrel-chain', 'default-export', 'interface-implementations', 'renamed-reexport', 'shadowed-name', 'type-only-import']) {
			expect(semanticTags.has(pattern)).toBe(true);
		}
	});

	it('freezes the six-case calibration subset across all task classes', () => {
		const {suite, cases} = loadSuite(calibrationPath);
		const release = loadSuite(releasePath);
		const pinned = suite.caseHashes;

		expect(suite.status).toBe('frozen');
		expect(suite.version).toBe(1);
		expect(suite.repetitions).toBe(1);
		expect(suite.revision).toBe(release.suite.revision);
		expect(suite.cases).toHaveLength(6);
		expect(classCountsOf(cases.map((testCase) => testCase.class))).toStrictEqual({
			locate: 1,
			impact: 2,
			implementation: 1,
			semantic: 2,
		});

		if (pinned === null) {
			throw new Error('the calibration suite must pin a case hash for every case');
		}

		expect(Object.keys(pinned).sort()).toStrictEqual([...suite.cases].sort());

		for (const testCase of cases) {
			expect(pinned[testCase.id]).toBe(caseHashOf(testCase));
			expect(release.suite.cases).toContain(testCase.id);
		}

		const plan = planOf(selectCases(cases, {}), ['no-index', 'accepted'], 1);

		expect(plan).toHaveLength(12);
	});
});
