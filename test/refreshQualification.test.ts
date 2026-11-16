import {describe, expect, it} from 'vitest';
import {
	REFRESH_QUALIFICATION_GATES,
	REFRESH_QUALIFICATION_GRID,
	REFRESH_QUALIFICATION_RSS_CEILINGS_BYTES,
	REFRESH_QUALIFICATION_SCENARIOS,
	REFRESH_QUALIFICATION_SELECTION,
	REFRESH_QUALIFICATION_TESTS,
	createRefreshQualificationReport,
	refreshQualificationContractDigest,
} from '../src/core/qualification/refreshQualification.ts';

const identities = {
	revision: '1234567',
	runtimeSha256: 'a'.repeat(64),
	configurationSha256: 'b'.repeat(64),
	fixturesSha256: 'c'.repeat(64),
};

describe('refresh qualification contract', () => {
	it('freezes all fifteen scenarios, gates, tuning candidates, and resource ceilings', () => {
		expect(REFRESH_QUALIFICATION_SCENARIOS).toHaveLength(15);
		expect(Object.keys(REFRESH_QUALIFICATION_TESTS)).toStrictEqual([...REFRESH_QUALIFICATION_SCENARIOS]);
		expect(Object.values(REFRESH_QUALIFICATION_TESTS).every((files) => files.length > 0)).toBe(true);
		expect(REFRESH_QUALIFICATION_GATES).toHaveLength(20);
		expect(REFRESH_QUALIFICATION_GRID).toHaveLength(3);
		expect(REFRESH_QUALIFICATION_SELECTION).toStrictEqual(REFRESH_QUALIFICATION_GRID[1]);
		expect(REFRESH_QUALIFICATION_RSS_CEILINGS_BYTES).toStrictEqual([2 * 1024 ** 3, 4 * 1024 ** 3, 6 * 1024 ** 3]);
		expect(refreshQualificationContractDigest()).toMatch(/^[0-9a-f]{64}$/u);
	});

	it('fails every scenario and gate on a failed or timed-out execution', () => {
		const passing = createRefreshQualificationReport({
			identities,
			executions: [{id: 'all', durationMs: 10, exitCode: 0, timedOut: false}],
		});
		const failing = createRefreshQualificationReport({
			identities,
			executions: [{id: 'all', durationMs: 10, exitCode: null, timedOut: true}],
		});

		expect(passing.status).toBe('pass');
		expect(passing.scenarios.every((scenario) => scenario.status === 'pass')).toBe(true);
		expect(passing.gates.every((gate) => gate.status === 'pass')).toBe(true);
		expect(failing.status).toBe('failure');
		expect(failing.scenarios.every((scenario) => scenario.status === 'failure')).toBe(true);
		expect(failing.gates.every((gate) => gate.status === 'failure')).toBe(true);
	});
});
