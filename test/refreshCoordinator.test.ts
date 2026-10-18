import {once} from 'node:events';
import {setImmediate as immediate} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import {RefreshCoordinator, type ClockType} from '../src/index/refreshCoordinator.ts';
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
		const runRefresh = async (): Promise<void> => {
			calls += 1;
			await Promise.resolve();
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
		const runRefresh = async (): Promise<void> => {
			calls += 1;
			await once(gate, 'release');
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
		const runRefresh = async (): Promise<void> => {
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
		const runRefresh = async (): Promise<void> => {
			calls += 1;
			await Promise.resolve();
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
