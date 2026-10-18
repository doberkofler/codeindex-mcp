import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {buildAnalyticsDashboard} from '../src/core/analytics/dashboard.ts';

type EventFieldsType = Readonly<Record<string, unknown>>;

const createAnalyticsFile = (events: readonly EventFieldsType[]): Readonly<{file: string; cleanup: () => void}> => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-dashboard-'));
	const file = path.join(directory, 'events.jsonl');
	const lines = events.map((fields, index) =>
		JSON.stringify({
			schema: 1,
			id: `event-${index}`,
			program: 'code-index',
			programVersion: '0.1.0',
			projectId: 'project',
			workingCopyId: 'copy',
			...fields,
		}),
	);

	writeFileSync(file, `${lines.join('\n')}\n`, {encoding: 'utf8'});

	return {
		file,
		cleanup: () => {
			rmSync(directory, {recursive: true, force: true});
		},
	};
};

const timestamp = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

describe('console analytics dashboard', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('aggregates tool, build, freshness, and watcher signals', () => {
		const first = timestamp(-60 * 60 * 1000);
		const second = timestamp(-30 * 60 * 1000);
		const created = createAnalyticsFile([
			{event: 'mcp_tool_call', timestamp: first, tool: 'find_symbol', durationMs: 10, bytes: 100, ok: true, freshness: 'current', truncated: false},
			{event: 'mcp_tool_call', timestamp: second, tool: 'find_symbol', durationMs: 50, bytes: 200, ok: false, freshness: 'stale', truncated: true},
			{event: 'build_complete', timestamp: second, durationMs: 1000, stages: {scanMs: 100, extractionMs: 400}},
			{event: 'build_failed', timestamp: second, durationMs: 500},
			{event: 'refresh_published', timestamp: second, eventToPublicationMs: 80},
			{event: 'refresh_coalesced', timestamp: second},
			{event: 'watcher_event', timestamp: second, projectWide: false, pathCount: 2},
		]);
		const {file, cleanup: dispose} = created;
		cleanup = dispose;

		const dashboard = buildAnalyticsDashboard(file, '24h');

		expect(dashboard.window.events).toBe(7);
		expect(dashboard.totals).toMatchObject({
			toolCalls: 2,
			errors: 1,
			errorRate: 0.5,
			builds: 2,
			buildFailures: 1,
			refreshes: 1,
			coalesced: 1,
			bytes: 300,
			truncated: 1,
		});
		expect(dashboard.tools[0]).toMatchObject({name: 'find_symbol', calls: 2, errors: 1, p50Ms: 10, p95Ms: 50});
		expect(dashboard.tools[0]?.latencyBuckets.find((bucket) => bucket.upperMs === 10)?.count).toBe(1);
		expect(dashboard.freshness).toContainEqual({state: 'current', count: 1});
		expect(dashboard.freshness).toContainEqual({state: 'stale', count: 1});
		expect(dashboard.builds.stages).toContainEqual({stage: 'scanMs', p50Ms: 100, p95Ms: 100});
		expect(dashboard.builds.timeline.map((point) => point.outcome)).toStrictEqual(['complete', 'failed']);
		expect(dashboard.watcher).toMatchObject({events: 2, refreshes: 1, coalesced: 1, eventToPublicationP95Ms: 80});
		expect(dashboard.timeline.length).toBeGreaterThan(0);
	});

	it('filters the dashboard window without exposing raw events', () => {
		const old = timestamp(-3 * 60 * 60 * 1000);
		const recent = timestamp(-5 * 60 * 1000);
		const created = createAnalyticsFile([
			{event: 'mcp_tool_call', timestamp: old, tool: 'outline', durationMs: 20, bytes: 10, ok: true, freshness: 'current', truncated: false},
			{event: 'mcp_tool_call', timestamp: recent, tool: 'find_references', durationMs: 30, bytes: 20, ok: true, freshness: 'current', truncated: false},
		]);
		const {file, cleanup: dispose} = created;
		cleanup = dispose;

		const dashboard = buildAnalyticsDashboard(file, '1h');

		expect(dashboard.window.events).toBe(1);
		expect(dashboard.tools.map((tool) => tool.name)).toStrictEqual(['find_references']);
		expect(dashboard).not.toHaveProperty('events');
	});
});
