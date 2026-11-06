import {describe, expect, it} from 'vitest';
import {phaseOf} from '../src/core/benchmark/benchmarkPhase.ts';

describe('benchmark phase progress', () => {
	it('reports phase start and completion', async () => {
		const progress: string[] = [];

		await expect(
			phaseOf('cold_build', Promise.resolve('done'), (event) => {
				progress.push(`${event.phase}:${event.status}`);
			}),
		).resolves.toBe('done');
		expect(progress).toStrictEqual(['cold_build:started', 'cold_build:completed']);
	});

	it('reports a failed phase before labelling the error', async () => {
		const progress: string[] = [];

		await expect(
			phaseOf('queries', Promise.reject(new Error('broken')), (event) => {
				progress.push(`${event.phase}:${event.status}`);
			}),
		).rejects.toThrow('queries failed: broken');
		expect(progress).toStrictEqual(['queries:started', 'queries:failed']);
	});
});
