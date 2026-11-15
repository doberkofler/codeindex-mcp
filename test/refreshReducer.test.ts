import {describe, expect, it} from 'vitest';
import {createRefreshReducerState, reduceRefresh, type RefreshReducerStateType} from '../src/core/freshness/refreshReducer.ts';

type OutcomeType = 'published' | 'superseded' | 'failed';

const request = (state: RefreshReducerStateType, adapterId: string, now: number): RefreshReducerStateType =>
	reduceRefresh(state, {
		type: 'request',
		now,
		reason: 'change',
		adapterIds: [adapterId],
		paths: [`${adapterId}/${String(now)}.sql`],
		force: false,
		requestId: null,
		immediate: false,
		onlyIfClean: false,
	});

const complete = (state: RefreshReducerStateType, outcome: OutcomeType, attemptId: number, adapterId: string): RefreshReducerStateType => {
	if (outcome === 'published') {
		return reduceRefresh(state, {type: 'published', now: 200, attemptId});
	}

	if (outcome === 'superseded') {
		return reduceRefresh(state, {type: 'superseded', now: 200, attemptId, maximumBackoffMs: 1000});
	}

	return reduceRefresh(state, {type: 'failed', now: 200, attemptId, adapterId, error: 'failed', maximumRetryMs: 1000});
};

const verifySequence = (adapterId: string, outcome: OutcomeType, laterEventCount: number): void => {
	let state = createRefreshReducerState(
		[
			{id: 'oracle', debounceMs: 100},
			{id: 'typescript', debounceMs: 100},
		],
		0,
		true,
	);
	state = request(state, adapterId, 0);
	state = reduceRefresh(state, {type: 'capture', now: 100});
	const attemptId = state.active?.id;

	expect(attemptId).toBeDefined();

	for (let eventIndex = 0; eventIndex < laterEventCount; eventIndex += 1) {
		state = request(state, adapterId, 101 + eventIndex);
	}

	if (attemptId === undefined) {
		throw new Error('Expected an active attempt');
	}

	state = complete(state, outcome, attemptId, adapterId);
	const adapter = state.adapters.get(adapterId);
	const untouched = state.adapters.get(adapterId === 'oracle' ? 'typescript' : 'oracle');
	expect(adapter?.dirtyEpoch).toBe(1 + laterEventCount);
	expect(adapter?.confirmedEpoch).toBe(outcome === 'published' ? 1 : 0);
	expect(adapter?.confirmedEpoch).toBeLessThanOrEqual(adapter?.dirtyEpoch ?? -1);
	expect(untouched).toMatchObject({dirtyEpoch: 0, confirmedEpoch: 0});
};

describe('refresh reducer epoch properties', () => {
	it('only confirmed captured epochs clear across event and outcome sequences', () => {
		expect.hasAssertions();
		const outcomes: readonly OutcomeType[] = ['published', 'superseded', 'failed'];

		for (const adapterId of ['oracle', 'typescript']) {
			for (const outcome of outcomes) {
				for (let laterEventCount = 0; laterEventCount <= 5; laterEventCount += 1) {
					verifySequence(adapterId, outcome, laterEventCount);
				}
			}
		}
	});
});
