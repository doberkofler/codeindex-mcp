import {afterEach, describe, expect, it, vi} from 'vitest';
import {type BuildLeaseHeartbeatFailureType, startBuildLeaseHeartbeat} from '../src/core/generation/buildLeaseHeartbeat.ts';

describe('build lease heartbeat', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('contains renewal exceptions inside the timer', () => {
		vi.useFakeTimers();
		const failures: BuildLeaseHeartbeatFailureType[] = [];
		const stop = startBuildLeaseHeartbeat({
			renew: () => {
				throw new Error('database is locked');
			},
			intervalMs: 10,
			onFailure: (failure) => {
				failures.push(failure);
			},
		});

		expect(() => {
			vi.advanceTimersByTime(10);
		}).not.toThrow();
		expect(failures).toStrictEqual(['error']);
		stop();
	});

	it('reports a missed renewal and stops on request', () => {
		vi.useFakeTimers();
		const failures: BuildLeaseHeartbeatFailureType[] = [];
		const stop = startBuildLeaseHeartbeat({
			renew: () => false,
			intervalMs: 10,
			onFailure: (failure) => {
				failures.push(failure);
			},
		});

		vi.advanceTimersByTime(25);
		expect(failures).toStrictEqual(['lost', 'lost']);
		stop();
		vi.advanceTimersByTime(25);
		expect(failures).toStrictEqual(['lost', 'lost']);
	});
});
