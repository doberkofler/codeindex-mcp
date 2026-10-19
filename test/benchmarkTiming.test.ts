import {describe, expect, it} from 'vitest';
import {phaseOf} from '../src/core/benchmark/benchmarkPhase.ts';
import {measure, summarize} from '../src/core/benchmark/percentiles.ts';

const rejectionOf = async (reason: unknown): Promise<never> => {
	await Promise.resolve();
	throw reason;
};

describe('benchmark percentiles', () => {
	it('summarizes samples with nearest-rank percentiles', () => {
		expect(summarize([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toStrictEqual({
			count: 10,
			p50Ms: 5,
			p95Ms: 10,
			p99Ms: 10,
			maxMs: 10,
		});
	});

	it('reports empty samples without percentiles', () => {
		expect(summarize([])).toStrictEqual({count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null});
	});

	it('measures synchronous work', () => {
		let called = false;

		const duration = measure(() => {
			called = true;
		});

		expect(called).toBe(true);
		expect(duration).toBeGreaterThanOrEqual(0);
	});
});

describe('benchmark phase failures', () => {
	it('passes successful results through', async () => {
		await expect(phaseOf('cold_build', Promise.resolve('result'))).resolves.toBe('result');
	});

	it('labels errors and retains their cause', async () => {
		const failure = new Error('disk full');

		await expect(phaseOf('queries', Promise.reject(failure))).rejects.toMatchObject({
			message: 'queries failed: disk full',
			cause: failure,
		});
	});

	it('labels non-error rejections', async () => {
		await expect(phaseOf('edit_to_fresh', rejectionOf('offline'))).rejects.toThrow('edit_to_fresh failed: offline');
	});

	it('appends SQLite error details when available', async () => {
		await expect(phaseOf('deep_cursor', rejectionOf({errcode: 11, errstr: 'disk I/O error'}))).rejects.toThrow(
			'deep_cursor failed: [object Object] (sqlite errcode 11: disk I/O error)',
		);
		await expect(phaseOf('warm_reuse', rejectionOf({errcode: 5}))).rejects.toThrow('warm_reuse failed: [object Object] (sqlite errcode 5)');
		await expect(phaseOf('warm_rebuild', rejectionOf({errcode: '5', errstr: 'ignored'}))).rejects.toThrow('warm_rebuild failed: [object Object]');
	});
});
