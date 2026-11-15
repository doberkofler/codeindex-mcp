import {setImmediate as immediate} from 'node:timers/promises';
import {type ClockType} from '../../src/core/freshness/refreshCoordinator.ts';
import {type BuildReportType} from '../../src/core/model.ts';

type TimerType = ReturnType<typeof setTimeout>;

type FakeTimerRecordType = {
	readonly handle: TimerType;
	readonly action: () => void;
	at: number;
	readonly intervalMs: number | null;
};

export type RefreshCallType = Readonly<{
	reason: string;
	adapterIds: readonly string[] | null;
	force: boolean;
	signal: AbortSignal;
	at: number;
}>;

export const TYPESCRIPT_ADAPTER = {id: 'typescript', debounceMs: 500};
export const ORACLE_ADAPTER = {id: 'oracle', debounceMs: 500};

export const refreshReport = (revision: number, outcome: BuildReportType['outcome'] = 'published'): BuildReportType => ({
	generationId: 'generation',
	revision,
	state: outcome === 'superseded' ? 'superseded' : 'published',
	outcome,
	reused: outcome === 'reused',
	durationMs: 1,
	fileCount: 1,
	symbolCount: 1,
	occurrenceCount: 1,
	dependencyEdgeCount: 0,
	dependencyBindingCount: 0,
	diagnosticCount: 0,
	stages: null,
});

export const flushRefresh = async (): Promise<void> => {
	await immediate();
};

const nextDue = (timers: ReadonlyMap<TimerType, FakeTimerRecordType>, now: number): FakeTimerRecordType | undefined =>
	[...timers.values()]
		.filter((timer) => timer.at <= now)
		.sort((left, right) => left.at - right.at)
		.at(0);

export const createRefreshClock = (): Readonly<{
	clock: ClockType;
	now: () => number;
	advance: (milliseconds: number) => Promise<void>;
	pendingTimerCount: () => number;
}> => {
	let now = 0;
	const timers = new Map<TimerType, FakeTimerRecordType>();
	const create = (action: () => void, delayMs: number, intervalMs: number | null): TimerType => {
		const handle = setTimeout((): void => {
			// The native handle is only an opaque fake-clock token.
		}, 1);
		clearTimeout(handle);
		timers.set(handle, {handle, action, at: now + delayMs, intervalMs});
		return handle;
	};
	const clock: ClockType = {
		now: () => now,
		setTimeout: (action, delayMs) => create(action, delayMs, null),
		clearTimeout: (handle) => {
			timers.delete(handle);
		},
		setInterval: (action, delayMs) => create(action, delayMs, delayMs),
		clearInterval: (handle) => {
			timers.delete(handle);
		},
	};
	const runDue = async (): Promise<void> => {
		const due = nextDue(timers, now);

		if (due === undefined) {
			return;
		}

		if (due.intervalMs === null) {
			timers.delete(due.handle);
		} else {
			due.at += due.intervalMs;
		}

		due.action();
		await flushRefresh();
		await runDue();
	};
	const advance = async (milliseconds: number): Promise<void> => {
		now += milliseconds;
		await runDue();
	};

	return {clock, now: () => now, advance, pendingTimerCount: () => timers.size};
};
