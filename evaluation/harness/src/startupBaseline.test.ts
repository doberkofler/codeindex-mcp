import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {mcpCallGateStatusOf, startupGateStatusOf, summarizeStartup} from './startupBaseline.ts';

describe('warm startup baseline', () => {
	it('summarizes nearest-rank percentiles', () => {
		const summary = summarizeStartup([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

		assert.equal(summary.count, 10);
		assert.equal(summary.p50Ms, 50);
		assert.equal(summary.p95Ms, 100);
		assert.equal(summary.p99Ms, 100);
		assert.equal(summary.maxMs, 100);
	});

	it('returns null percentiles for an empty sample', () => {
		assert.deepEqual(summarizeStartup([]), {count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null});
	});

	it('gates on the declared p95 budget', () => {
		assert.equal(startupGateStatusOf(499.9), 'pass');
		assert.equal(startupGateStatusOf(500), 'pass');
		assert.equal(startupGateStatusOf(500.1), 'fail');
		assert.equal(startupGateStatusOf(null), 'fail');
	});

	it('gates local MCP call latency independently of startup', () => {
		assert.equal(mcpCallGateStatusOf(99.9), 'pass');
		assert.equal(mcpCallGateStatusOf(100), 'pass');
		assert.equal(mcpCallGateStatusOf(100.1), 'fail');
		assert.equal(mcpCallGateStatusOf(null), 'fail');
	});
});
