import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {formatAnalyticsHtml, formatAnalyticsText, summarizeAnalytics} from '../src/core/analytics/report.ts';

const directories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-analytics-summary-'));
	directories.push(directory);
	return directory;
};

const event = (id: string, name: string, timestamp: string, fields: Readonly<Record<string, unknown>> = {}): string =>
	JSON.stringify({
		schema: 1,
		id,
		timestamp,
		program: 'code-index',
		programVersion: '0.1.0',
		projectId: 'project',
		workingCopyId: null,
		event: name,
		...fields,
	});

const writeEvents = (lines: readonly string[]): string => {
	const directory = temporaryDirectory();
	const filePath = path.join(directory, 'events.jsonl');
	mkdirSync(directory, {recursive: true});
	writeFileSync(filePath, `${lines.join('\n')}\n`, {encoding: 'utf8'});
	return filePath;
};

describe('analytics summaries', () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('aggregates every event family and counts invalid, duplicate, and expired rows', () => {
		const now = new Date().toISOString();
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const analyticsPath = writeEvents([
			'',
			'not json',
			JSON.stringify({schema: 1}),
			event('e1', 'mcp_tool_call', now),
			event('e2', 'mcp_tool_call', now, {tool: 'find_symbol', durationMs: 10, bytes: 20, ok: false, truncated: true, freshness: 'current'}),
			event('e3', 'build_complete', now, {durationMs: 100, stages: {scanMs: 5, ignored: 'x'}}),
			event('e4', 'build_complete', now, {durationMs: 200, stages: null}),
			event('e5', 'build_failed', now, {durationMs: 50}),
			event('e6', 'refresh_published', now, {eventToPublicationMs: 7}),
			event('e7', 'refresh_coalesced', now),
			event('e8', 'watcher_event', now),
			event('e1', 'mcp_tool_call', now),
			event('old', 'process_start', old),
		]);

		const summary = summarizeAnalytics(analyticsPath, '24h');

		expect(summary).toMatchObject({
			files: 1,
			duplicates: 1,
			invalid: 2,
			since: '24h',
			firstTimestamp: now,
			lastTimestamp: now,
			tools: {
				unknown: {calls: 0, errors: 0, p50Ms: null, bytes: 0, truncated: 0},
				find_symbol: {calls: 1, errors: 1, p50Ms: 10, p95Ms: 10, p99Ms: 10, bytes: 20, truncated: 1},
			},
			builds: {count: 2, failures: 1, p50Ms: 100, stages: {scanMs: 5}},
			freshness: {current: 1},
			watcher: {events: 2, refreshes: 1, coalesced: 1, eventToPublicationP95Ms: 7},
		});
		expect(summary.events).toBe(8);
		expect(summary.counts).toMatchObject({mcp_tool_call: 2, build_complete: 2, build_failed: 1});

		const text = formatAnalyticsText(summary).join('\n');

		expect(text).toContain('find_symbol: calls 1');
		expect(text).toContain('scanMs: 5 ms');
	});

	it('keeps older events when the window is unknown or wider', () => {
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const analyticsPath = writeEvents([event('old', 'process_start', old)]);

		expect(summarizeAnalytics(analyticsPath, 'all').events).toBe(1);
		expect(summarizeAnalytics(analyticsPath, '7d').events).toBe(1);
		expect(summarizeAnalytics(analyticsPath, '30m').events).toBe(0);
		expect(summarizeAnalytics(path.join(path.dirname(analyticsPath), 'missing', 'events.jsonl'), '30m')).toMatchObject({files: 0, events: 0});
	});

	it('renders text and escaped HTML for dashboards', () => {
		const now = new Date().toISOString();
		const analyticsPath = writeEvents([event('e1', 'mcp_tool_call', now, {tool: '<script>&"', durationMs: 4, bytes: 8, freshness: 'stale'})]);
		const summary = summarizeAnalytics(analyticsPath);

		const text = formatAnalyticsText(summary).join('\n');
		const html = formatAnalyticsHtml(summary);

		expect(text).toContain('<script>&"');
		expect(text).toContain('builds: 0, failures 0, p50 - ms');
		expect(text).toContain('freshness: {"stale":1}');
		expect(html).toContain('&lt;script&gt;&amp;&quot;');
		expect(html).toContain('1 events');
		expect(html).toContain('stale');
	});
});
