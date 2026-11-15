import {once} from 'node:events';
import {describe, expect, it} from 'vitest';
import {RefreshCoordinator} from '../src/core/freshness/refreshCoordinator.ts';
import {type BuildReportType} from '../src/core/model.ts';
import {silentLogger} from './helpers/fixture.ts';
import {
	createRefreshClock as createClock,
	flushRefresh as flush,
	ORACLE_ADAPTER as ORACLE,
	refreshReport as report,
	type RefreshCallType as CallType,
	TYPESCRIPT_ADAPTER as TYPESCRIPT,
} from './helpers/refreshCoordinator.ts';

describe('RefreshCoordinator adapter scheduling', () => {
	it('A: keeps every captured adapter dirty when TypeScript supersedes a full attempt', async () => {
		const {clock, now, advance} = createClock();
		const gate = new EventTarget();
		const calls: CallType[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [ORACLE, TYPESCRIPT],
			runRefresh: async (reason, adapterIds, force, signal): Promise<BuildReportType> => {
				calls.push({reason, adapterIds, force, signal, at: now()});

				if (calls.length === 1) {
					await once(gate, 'release');
				}

				return report(calls.length, signal.aborted ? 'superseded' : 'published');
			},
			logger: silentLogger,
			clock,
		});

		coordinator.start();
		await advance(500);
		coordinator.request({kind: 'change', paths: ['src/a.ts'], adapterIds: ['typescript']});
		gate.dispatchEvent(new Event('release'));
		await flush();
		await advance(500);

		expect(calls.map((call) => call.adapterIds)).toStrictEqual([null, null]);
		expect(coordinator.getFreshness().state).toBe('current');
		await coordinator.close();
	});

	it('B: preserves an Oracle failure while pending TypeScript work publishes', async () => {
		const {clock, now, advance} = createClock();
		const gate = new EventTarget();
		const calls: CallType[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [
				{id: 'oracle', debounceMs: 500},
				{id: 'typescript', debounceMs: 100},
			],
			runRefresh: async (reason, adapterIds, force, signal): Promise<BuildReportType> => {
				calls.push({reason, adapterIds, force, signal, at: now()});

				if (calls.length === 2) {
					await once(gate, 'release');
					throw new Error('oracle unavailable');
				}

				return report(calls.length);
			},
			logger: silentLogger,
			clock,
		});

		coordinator.start();
		await advance(500);
		coordinator.request({kind: 'change', paths: ['db/package.pkb'], adapterIds: ['oracle']});
		await advance(500);
		coordinator.request({kind: 'change', paths: ['src/a.ts'], adapterIds: ['typescript']});
		gate.dispatchEvent(new Event('release'));
		await flush();
		await advance(100);

		expect(calls[2]?.adapterIds).toStrictEqual(['typescript']);
		expect(coordinator.getFreshness(['typescript']).state).toBe('current');
		expect(coordinator.getFreshness(['oracle']).state).toBe('stale');
		expect(coordinator.getFreshness().state).toBe('stale');
		expect(coordinator.getSnapshot().lastError).toContain('oracle unavailable');

		await advance(400);
		expect(calls[3]?.adapterIds).toStrictEqual(['oracle']);
		await coordinator.close();
	});
});

describe('RefreshCoordinator failure and absolute deadlines', () => {
	it('keeps only an attributed failed adapter stale after unrelated captured work succeeds', async () => {
		const {clock, advance} = createClock();
		const failure = new Error('oracle unavailable');
		const scopes: (readonly string[] | null)[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [
				{id: 'oracle', debounceMs: 100},
				{id: 'typescript', debounceMs: 100},
			],
			failedAdapterId: (error): string | null => (error === failure ? 'oracle' : null),
			runRefresh: async (_reason, adapterIds): Promise<BuildReportType> => {
				scopes.push(adapterIds);
				await Promise.resolve();

				if (scopes.length === 1) {
					throw failure;
				}

				return report(scopes.length);
			},
			logger: silentLogger,
			clock,
		});

		coordinator.start();
		await advance(100);

		expect(scopes).toStrictEqual([null, ['typescript']]);
		expect(coordinator.getFreshness(['typescript']).state).toBe('current');
		expect(coordinator.getFreshness(['oracle']).state).toBe('stale');
		await coordinator.close();
	});

	it('C: never lets capped supersession backoff undercut the absolute debounce deadline', async () => {
		const {clock, now, advance} = createClock();
		const gate = new EventTarget();
		const calls: CallType[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [{id: 'typescript', debounceMs: 90_000}],
			runRefresh: async (reason, adapterIds, force, signal): Promise<BuildReportType> => {
				calls.push({reason, adapterIds, force, signal, at: now()});

				if (calls.length === 1) {
					await once(gate, 'release');
				}

				return report(calls.length, signal.aborted ? 'superseded' : 'published');
			},
			logger: silentLogger,
			clock,
			supersededBackoffMaxMs: 30_000,
		});

		coordinator.start();
		await advance(90_000);
		coordinator.request({kind: 'change', paths: ['src/a.ts'], adapterIds: ['typescript']});
		gate.dispatchEvent(new Event('release'));
		await flush();
		await advance(30_000);
		expect(calls).toHaveLength(1);
		await advance(59_999);
		expect(calls).toHaveLength(1);
		await advance(1);

		expect(calls[1]?.at).toBe(180_000);
		await coordinator.close();
	});
});

describe('RefreshCoordinator elapsed and newer deadlines', () => {
	it('D: starts work whose deadline elapsed during another adapter build without another debounce', async () => {
		const {clock, now, advance} = createClock();
		const gate = new EventTarget();
		const calls: CallType[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [
				{id: 'oracle', debounceMs: 90_000},
				{id: 'typescript', debounceMs: 90_000},
			],
			runRefresh: async (reason, adapterIds, force, signal): Promise<BuildReportType> => {
				calls.push({reason, adapterIds, force, signal, at: now()});

				if (calls.length === 2) {
					await once(gate, 'release');
				}

				return report(calls.length);
			},
			logger: silentLogger,
			clock,
		});

		coordinator.start();
		await advance(90_000);
		coordinator.request({kind: 'change', paths: ['db/package.pkb'], adapterIds: ['oracle']});
		await advance(90_000);
		coordinator.request({kind: 'change', paths: ['src/a.ts'], adapterIds: ['typescript']});
		await advance(90_000);
		gate.dispatchEvent(new Event('release'));
		await flush();

		expect(calls[2]).toMatchObject({adapterIds: ['typescript'], at: 270_000});
		await coordinator.close();
	});

	it('does not clear an event newer than the captured epoch when the attempt still publishes', async () => {
		const {clock, advance} = createClock();
		const gate = new EventTarget();
		let calls = 0;
		const coordinator = new RefreshCoordinator({
			adapters: [{id: 'typescript', debounceMs: 100}],
			runRefresh: async (): Promise<BuildReportType> => {
				calls += 1;

				if (calls === 1) {
					await once(gate, 'release');
				}

				return report(calls);
			},
			logger: silentLogger,
			clock,
		});

		coordinator.start();
		await advance(100);
		coordinator.request({kind: 'change', paths: ['src/new.ts'], adapterIds: ['typescript']});
		gate.dispatchEvent(new Event('release'));
		await flush();

		expect(coordinator.getFreshness().state).toBe('updating');
		expect(coordinator.isPathDirty('src/new.ts', 'typescript')).toBe(true);
		await advance(100);
		expect(calls).toBe(2);
		expect(coordinator.getFreshness().state).toBe('current');
		await coordinator.close();
	});
});

describe('RefreshCoordinator scoped invalidation', () => {
	it('clears a metadata-only project invalidation after an unchanged scan', async () => {
		const {clock, advance} = createClock();
		const coordinator = new RefreshCoordinator({
			adapters: [ORACLE, TYPESCRIPT],
			initiallyCurrent: true,
			runRefresh: async (): Promise<BuildReportType> => {
				await Promise.resolve();
				return report(1, 'reused');
			},
			logger: silentLogger,
			clock,
		});

		coordinator.request({kind: 'change', paths: null, adapterIds: ['oracle']});
		expect(coordinator.getFreshness(['oracle']).state).toBe('updating');
		expect(coordinator.getSnapshot().projectWideInvalidation).toBe(true);
		await advance(500);

		expect(coordinator.getFreshness(['oracle']).state).toBe('current');
		expect(coordinator.getSnapshot().projectWideInvalidation).toBe(false);
		await coordinator.close();
	});

	it('never cancels one adapter for an event owned only by another adapter', async () => {
		const {clock, advance} = createClock();
		const gate = new EventTarget();
		const signals: AbortSignal[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [ORACLE, TYPESCRIPT],
			initiallyCurrent: true,
			runRefresh: async (_reason, _adapterIds, _force, signal): Promise<BuildReportType> => {
				signals.push(signal);
				await once(gate, 'release');
				return report(signals.length);
			},
			logger: silentLogger,
			clock,
		});

		coordinator.request({kind: 'change', paths: ['src/a.ts'], adapterIds: ['typescript']});
		await advance(500);
		coordinator.request({kind: 'change', paths: ['db/package.pkb'], adapterIds: ['oracle']});

		expect(signals[0]?.aborted).toBe(false);
		gate.dispatchEvent(new Event('release'));
		await flush();
		await coordinator.close();
	});
});

describe('RefreshCoordinator freshness and lifecycle', () => {
	it('prevents false-current state while another adapter remains dirty', async () => {
		const {clock, advance} = createClock();
		const coordinator = new RefreshCoordinator({
			adapters: [
				{id: 'oracle', debounceMs: 500},
				{id: 'typescript', debounceMs: 100},
			],
			initiallyCurrent: true,
			runRefresh: async (): Promise<BuildReportType> => {
				await Promise.resolve();
				return report(1);
			},
			logger: silentLogger,
			clock,
		});

		coordinator.request({kind: 'change', paths: ['src/a.ts'], adapterIds: ['typescript']});
		coordinator.request({kind: 'change', paths: ['db/package.pkb'], adapterIds: ['oracle']});
		await advance(100);

		expect(coordinator.getFreshness(['typescript']).state).toBe('current');
		expect(coordinator.getFreshness(['oracle']).state).toBe('updating');
		expect(coordinator.getFreshness().state).toBe('updating');
		await coordinator.close();
	});

	it('applies capped exponential supersession backoff per adapter', async () => {
		const {clock, now, advance} = createClock();
		const starts: number[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [{id: 'typescript', debounceMs: 500}],
			runRefresh: async (): Promise<BuildReportType> => {
				starts.push(now());
				await Promise.resolve();
				return report(starts.length, 'superseded');
			},
			logger: silentLogger,
			clock,
			supersededBackoffMaxMs: 2000,
		});

		coordinator.start();
		await advance(500);
		await advance(500);
		await advance(1000);
		await advance(2000);
		await advance(2000);

		expect(starts).toStrictEqual([500, 1000, 2000, 4000, 6000]);
		await coordinator.close();
	});

	it('applies capped exponential failure retry per adapter', async () => {
		const {clock, now, advance} = createClock();
		const starts: number[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [{id: 'typescript', debounceMs: 500}],
			runRefresh: async (): Promise<BuildReportType> => {
				starts.push(now());
				await Promise.resolve();
				throw new Error('persistent failure');
			},
			logger: silentLogger,
			clock,
			failedRetryMaxMs: 2000,
		});

		coordinator.start();
		await advance(500);
		await advance(500);
		await advance(1000);
		await advance(2000);
		await advance(2000);

		expect(starts).toStrictEqual([500, 1000, 2000, 4000, 6000]);
		expect(coordinator.getFreshness().state).toBe('stale');
		await coordinator.close();
	});
});

describe('RefreshCoordinator lifecycle', () => {
	it('closes without leaving debounce or reconciliation timers', async () => {
		const {clock, pendingTimerCount} = createClock();
		const coordinator = new RefreshCoordinator({
			adapters: [TYPESCRIPT],
			initiallyCurrent: true,
			runRefresh: async (): Promise<BuildReportType> => {
				await Promise.resolve();
				return report(1);
			},
			logger: silentLogger,
			clock,
			reconcileIntervalMs: 60_000,
		});

		coordinator.start();
		expect(pendingTimerCount()).toBeGreaterThan(0);
		await coordinator.close();

		expect(pendingTimerCount()).toBe(0);
		expect(coordinator.getSnapshot().state).toBe('stopping');
	});

	it('cancels active work and rejects manual waiters during close', async () => {
		const {clock, pendingTimerCount} = createClock();
		const coordinator = new RefreshCoordinator({
			adapters: [TYPESCRIPT],
			initiallyCurrent: true,
			runRefresh: async (_reason, _adapterIds, _force, signal): Promise<BuildReportType> => {
				await once(signal, 'abort');
				return report(1, 'superseded');
			},
			logger: silentLogger,
			clock,
		});

		const manual = coordinator.request({kind: 'manual', force: false});
		const closing = coordinator.close();
		await expect(manual).rejects.toThrow('Refresh coordinator closed');
		await closing;

		expect(pendingTimerCount()).toBe(0);
	});
});
