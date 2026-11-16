import {setTimeout as delay} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import {BuildCancellationError, cancelExecution, createCancellationBuffer, executionContextOf} from '../src/core/generation/executionCancellation.ts';
import {startEventLoopSample} from '../src/core/resources/eventLoopSample.ts';

describe('worker runtime primitives', () => {
	it('shares cancellation state with adapter execution contexts', () => {
		const buffer = createCancellationBuffer();
		const context = executionContextOf(buffer);

		expect(context.isCancellationRequested()).toBe(false);
		expect(() => {
			context.throwIfCancellationRequested();
		}).not.toThrow();

		cancelExecution(buffer);

		expect(context.isCancellationRequested()).toBe(true);
		expect(() => {
			context.throwIfCancellationRequested();
		}).toThrow(BuildCancellationError);
	});

	it('stops an event-loop sample idempotently before its first probe', () => {
		const sample = startEventLoopSample();
		const result = sample.stop();

		expect(result['mainScheduledProbeCount']).toBe(0);
		expect(sample.stop()).toBe(result);
	});

	it('records scheduled event-loop probes', async () => {
		const sample = startEventLoopSample();
		await delay(35);
		const result = sample.stop();

		expect(result['mainEventLoopP99Ms']).toBeGreaterThanOrEqual(0);
		expect(result['mainScheduledProbeP95Ms']).toBeGreaterThanOrEqual(0);
		expect(result['mainScheduledProbeP99Ms']).toBeGreaterThanOrEqual(0);
		expect(result['mainScheduledProbeCount']).toBeGreaterThan(0);
	});
});
