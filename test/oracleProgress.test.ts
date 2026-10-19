import {describe, expect, it} from 'vitest';
import {formatDuration, phaseProgressLine} from '../src/core/qualification/oracle/live/oracleProgress.ts';

describe('Oracle live progress lines', () => {
	it('formats durations for progress output', () => {
		expect(formatDuration(950)).toBe('1s');
		expect(formatDuration(59_400)).toBe('59s');
		expect(formatDuration(60_000)).toBe('1m 00s');
		expect(formatDuration(71_200)).toBe('1m 11s');
	});

	it('reports counts and an ETA without object names', () => {
		expect(phaseProgressLine('Targets', 0, 100, 5000)).toBe('Targets: 0/100, 5s elapsed');
		expect(phaseProgressLine('Targets', 25, 100, 10_000)).toBe('Targets: 25/100, ETA ~30s');
		expect(phaseProgressLine('Targets', 100, 100, 42_000)).toBe('Targets: 100/100 complete in 42s');
	});
});
