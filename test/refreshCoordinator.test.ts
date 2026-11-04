import {once} from 'node:events';
import {setImmediate as immediate} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import {RefreshCoordinator, type ClockType} from '../src/core/freshness/refreshCoordinator.ts';
import {type BuildOutcomeType} from '../src/core/model.ts';
import {silentLogger} from './helpers/fixture.ts';

type TimerType = ReturnType<typeof setTimeout> & Readonly<{id: number}>;

type FakeTimerRecordType = {
	readonly id: number;
	readonly action: () => void;
	at: number;
	readonly intervalMs: number | null;
};

const flush = async (): Promise<void> => {
	await immediate();
};

const nextDue = (timers: ReadonlyMap<number, FakeTimerRecordType>, now: number): FakeTimerRecordType | undefined =>
	[...timers.values()]
		.filter((timer) => timer.at <= now)
		.sort((left, right) => left.at - right.at)
		.at(0);

const createClock = (): Readonly<{clock: ClockType; advance: (milliseconds: number) => Promise<void>}> => {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, FakeTimerRecordType>();
	const create = (action: () => void, delayMs: number, intervalMs: number | null): TimerType => {
		const id = nextId;
		nextId += 1;
		timers.set(id, {id, action, at: now + delayMs, intervalMs});
		return {id, unref: () => undefined, ref: () => undefined, hasRef: () => false, refresh: () => undefined} as unknown as TimerType;
	};
	const clock: ClockType = {
		now: () => now,
		setTimeout: (action, delayMs) => create(action, delayMs, null),
		clearTimeout: (handle) => {
			timers.delete((handle as unknown as Readonly<{id: number}>).id);
		},
		setInterval: (action, delayMs) => create(action, delayMs, delayMs),
		clearInterval: (handle) => {
			timers.delete((handle as unknown as Readonly<{id: number}>).id);
		},
	};
	const runDue = async (): Promise<void> => {
		const due = nextDue(timers, now);

		if (due === undefined) {
			return;
		}

		if (due.intervalMs === null) {
			timers.delete(due.id);
		} else {
			due.at += due.intervalMs;
		}

		due.action();
		await flush();
		await runDue();
	};
	const advance = async (milliseconds: number): Promise<void> => {
		now += milliseconds;
		await runDue();
	};

	return {clock, advance};
};

describe('RefreshCoordinator', () => {
	it('coalesces one event burst into one refresh', async () => {
		const {clock, advance} = createClock();
		let calls = 0;
		const runRefresh = async (): Promise<BuildOutcomeType> => {
			calls += 1;
			await Promise.resolve();
			return 'published';
		};
		const coordinator = new RefreshCoordinator({runRefresh, logger: silentLogger, clock, debounceMs: 500});

		coordinator.start();
		await advance(500);

		expect(calls).toBe(1);
		expect(coordinator.getSnapshot().state).toBe('current');

		coordinator.notify(['src/a.ts']);
		coordinator.notify(['src/b.ts']);
		await advance(500);

		expect(calls).toBe(2);
		expect(coordinator.getSnapshot().dirtyFileCount).toBe(0);
		await coordinator.close();
	});

	it('runs exactly one follow-up after events during a build', async () => {
		const {clock, advance} = createClock();
		const gate = new EventTarget();
		let calls = 0;
		const runRefresh = async (): Promise<BuildOutcomeType> => {
			calls += 1;
			await once(gate, 'release');
			return 'published';
		};
		const coordinator = new RefreshCoordinator({runRefresh, logger: silentLogger, clock, debounceMs: 500});

		coordinator.start();
		await advance(500);
		expect(calls).toBe(1);
		expect(coordinator.getSnapshot().state).toBe('building');

		coordinator.notify(['src/a.ts']);
		coordinator.notify(['src/b.ts']);
		expect(coordinator.getSnapshot().refreshAgain).toBe(true);
		gate.dispatchEvent(new Event('release'));
		await flush();
		expect(coordinator.getSnapshot().state).toBe('dirty');

		await advance(500);
		expect(calls).toBe(2);
		expect(coordinator.getSnapshot().state).toBe('building');
		gate.dispatchEvent(new Event('release'));
		await flush();
		await coordinator.close();
	});

	it('reports stale freshness after a failed refresh and accepts a retry', async () => {
		const {clock, advance} = createClock();
		let calls = 0;
		const runRefresh = async (): Promise<BuildOutcomeType> => {
			calls += 1;
			await Promise.resolve();
			throw new Error('build failed');
		};
		const coordinator = new RefreshCoordinator({runRefresh, logger: silentLogger, clock, debounceMs: 500});

		coordinator.start();
		await advance(500);

		expect(coordinator.getSnapshot().state).toBe('failed');
		expect(coordinator.getFreshness().state).toBe('stale');

		coordinator.notify(['src/a.ts']);
		await advance(500);
		expect(calls).toBe(2);
		await coordinator.close();
	});

	it('skips reconciliation while a refresh is pending', async () => {
		const {clock, advance} = createClock();
		let calls = 0;
		const runRefresh = async (): Promise<BuildOutcomeType> => {
			calls += 1;
			await Promise.resolve();
			return 'published';
		};
		const coordinator = new RefreshCoordinator({runRefresh, logger: silentLogger, clock, debounceMs: 500, reconcileIntervalMs: 60_000});

		coordinator.start();
		coordinator.requestReconcile();
		await advance(500);
		expect(calls).toBe(1);

		coordinator.requestReconcile();
		await advance(500);
		expect(calls).toBe(2);
		await coordinator.close();
	});
});

describe('RefreshCoordinator supersession', () => {
	it('supersedes once and publishes the single follow-up', async () => {
		const {clock, advance} = createClock();
		const events: {event: string; fields: Readonly<Record<string, unknown>> | undefined}[] = [];
		let calls = 0;
		const coordinator = new RefreshCoordinator({
			runRefresh: async (): Promise<BuildOutcomeType> => {
				calls += 1;
				await Promise.resolve();
				return calls === 1 ? 'superseded' : 'published';
			},
			logger: silentLogger,
			clock,
			debounceMs: 500,
			record: (event, fields): void => {
				events.push({event, fields});
			},
		});

		coordinator.start();
		await advance(500);

		expect(calls).toBe(1);
		expect(coordinator.getSnapshot().state).toBe('dirty');
		expect(coordinator.getFreshness().state).toBe('updating');
		expect(events.map((entry) => entry.event)).toContain('refresh_superseded');
		expect(events.map((entry) => entry.event)).not.toContain('refresh_failed');

		await advance(500);

		expect(calls).toBe(2);
		expect(coordinator.getSnapshot().state).toBe('current');
		expect(events.map((entry) => entry.event)).toContain('refresh_published');
		await coordinator.close();
	});

	it('backs off with a cap while churn keeps superseding', async () => {
		const {clock, advance} = createClock();
		const backoffs: number[] = [];
		const events: string[] = [];
		const coordinator = new RefreshCoordinator({
			runRefresh: async (): Promise<BuildOutcomeType> => {
				await Promise.resolve();
				return 'superseded';
			},
			logger: silentLogger,
			clock,
			debounceMs: 500,
			supersededBackoffMaxMs: 2000,
			record: (event, fields): void => {
				events.push(event);

				if (event === 'refresh_superseded') {
					backoffs.push(Number(fields?.['backoffMs']));
				}
			},
		});

		coordinator.start();
		await advance(500);
		expect(coordinator.getFreshness().state).toBe('updating');
		await advance(500);
		await advance(1000);
		await advance(2000);
		await advance(2000);

		expect(backoffs).toStrictEqual([500, 1000, 2000, 2000, 2000]);
		expect(events).not.toContain('refresh_failed');
		expect(events).not.toContain('refresh_published');
		expect(coordinator.getFreshness().state).toBe('updating');
		await coordinator.close();
	});
});

describe('RefreshCoordinator failure recovery', () => {
	it('runs one follow-up when a build fails with pending events', async () => {
		const {clock, advance} = createClock();
		const gate = new EventTarget();
		let calls = 0;
		const runRefresh = async (): Promise<BuildOutcomeType> => {
			calls += 1;
			await once(gate, 'release');

			if (calls === 1) {
				throw new Error('source changed during build');
			}

			return 'published';
		};
		const coordinator = new RefreshCoordinator({runRefresh, logger: silentLogger, clock, debounceMs: 500});

		coordinator.start();
		await advance(500);
		expect(calls).toBe(1);
		coordinator.notify(['src/a.ts']);
		expect(coordinator.getSnapshot().refreshAgain).toBe(true);
		gate.dispatchEvent(new Event('release'));
		await flush();
		expect(coordinator.getSnapshot().state).toBe('dirty');

		await advance(500);
		expect(calls).toBe(2);
		gate.dispatchEvent(new Event('release'));
		await flush();
		expect(coordinator.getSnapshot().state).toBe('current');
		await coordinator.close();
	});

	it('retries a failed refresh without waiting for a new event', async () => {
		const {clock, advance} = createClock();
		let calls = 0;
		const runRefresh = async (): Promise<BuildOutcomeType> => {
			calls += 1;
			await Promise.resolve();

			if (calls === 1) {
				throw new Error('transient read failure');
			}

			return 'published';
		};
		const coordinator = new RefreshCoordinator({runRefresh, logger: silentLogger, clock, debounceMs: 500});

		coordinator.start();
		await advance(500);
		expect(calls).toBe(1);
		expect(coordinator.getSnapshot().state).toBe('failed');

		// The failure produces no filesystem event, so recovery must come from the
		// bounded retry rather than from an unrelated edit.
		await advance(500);
		expect(calls).toBe(2);
		expect(coordinator.getSnapshot().state).toBe('current');
		expect(coordinator.getSnapshot().lastError).toBeNull();
		await coordinator.close();
	});

	it('backs off repeated failures without spinning', async () => {
		const {clock, advance} = createClock();
		let calls = 0;
		const coordinator = new RefreshCoordinator({
			runRefresh: async (): Promise<BuildOutcomeType> => {
				calls += 1;
				await Promise.resolve();
				throw new Error('persistent read failure');
			},
			logger: silentLogger,
			clock,
			debounceMs: 500,
			failedRetryMaxMs: 4000,
		});

		coordinator.start();
		await advance(500);
		expect(calls).toBe(1);

		await advance(500);
		expect(calls).toBe(2);
		await advance(1000);
		expect(calls).toBe(3);
		await advance(2000);
		expect(calls).toBe(4);
		await advance(4000);
		expect(calls).toBe(5);
		await advance(4000);
		expect(calls).toBe(6);

		expect(coordinator.getSnapshot().state).toBe('failed');
		await coordinator.close();
	});
});

describe('RefreshCoordinator publication timing', () => {
	it('records event-to-publication from the first dirty event', async () => {
		const {clock, advance} = createClock();
		const events: {event: string; fields: Readonly<Record<string, unknown>> | undefined}[] = [];
		const coordinator = new RefreshCoordinator({
			runRefresh: async (): Promise<BuildOutcomeType> => {
				await Promise.resolve();
				return 'published';
			},
			logger: silentLogger,
			clock,
			debounceMs: 500,
			record: (event, fields): void => {
				events.push({event, fields});
			},
		});

		coordinator.start();
		await advance(500);
		coordinator.notify(['src/a.ts']);
		await advance(500);

		const published = events.find((entry) => entry.event === 'refresh_published');
		const {eventToPublicationMs} = published?.fields ?? {};
		expect(eventToPublicationMs).toBe(500);
		await coordinator.close();
	});
});

describe('RefreshCoordinator idle scheduling', () => {
	it('performs no periodic rescan while the workspace is idle', async () => {
		const {clock, advance} = createClock();
		let calls = 0;
		const runRefresh = async (): Promise<BuildOutcomeType> => {
			calls += 1;
			await Promise.resolve();
			return 'published';
		};
		const coordinator = new RefreshCoordinator({runRefresh, logger: silentLogger, clock, debounceMs: 500});

		coordinator.start();
		await advance(500);
		expect(calls).toBe(1);

		// Ten idle minutes with no filesystem event: the startup refresh is the
		// only work the coordinator may schedule. A healthy watcher is the change
		// detector; rescanning the whole workspace on a timer burns idle CPU.
		await advance(600_000);

		expect(calls).toBe(1);
		expect(coordinator.getSnapshot().state).toBe('current');
		await coordinator.close();
	});
});
