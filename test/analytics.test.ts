import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {assertAnalyticsFields, parseAnalyticsEvent, PROHIBITED_ANALYTICS_FIELDS} from '../src/core/analytics/events.ts';
import {createAnalyticsRecorder, type AnalyticsRecorderType} from '../src/core/analytics/recorder.ts';
import {summarizeAnalytics} from '../src/core/analytics/report.ts';

let directory: string | undefined;

const cleanupAnalytics = (): void => {
	if (directory !== undefined) {
		rmSync(directory, {recursive: true, force: true});
	}

	directory = undefined;
};

const recorderIn = (enabled: boolean): Readonly<{analyticsPath: string; recorder: AnalyticsRecorderType}> => {
	directory = mkdtempSync(path.join(tmpdir(), 'code-index-analytics-'));
	const analyticsPath = path.join(directory, 'analytics', 'events.jsonl');

	return {
		analyticsPath,
		recorder: createAnalyticsRecorder({
			enabled,
			path: analyticsPath,
			projectId: 'project',
			program: 'code-index',
			programVersion: '0.1.0',
			workingCopyId: 'wc',
		}),
	};
};

describe('analytics', () => {
	afterEach(cleanupAnalytics);

	it('writes versioned events and aggregates tool percentiles', () => {
		const {analyticsPath, recorder} = recorderIn(true);

		recorder.record('mcp_tool_call', {tool: 'find_symbol', durationMs: 10, bytes: 100, ok: true, freshness: 'current'});
		recorder.record('mcp_tool_call', {tool: 'find_symbol', durationMs: 30, bytes: 200, ok: false, errorCode: 'invalid_argument'});
		recorder.record('build_complete', {durationMs: 1000, stages: {scanMs: 5, extractionMs: 500}});
		recorder.close();

		const lines = readFileSync(analyticsPath, 'utf8').trim().split('\n');
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({schema: 1, event: 'mcp_tool_call', projectId: 'project'});

		const summary = summarizeAnalytics(analyticsPath);

		expect(summary.events).toBe(3);
		expect(summary.tools['find_symbol']).toMatchObject({calls: 2, errors: 1, p50Ms: 10, p95Ms: 30, bytes: 300});
		expect(summary.builds.count).toBe(1);
		expect(summary.freshness).toStrictEqual({current: 1});
	});

	it('performs no filesystem access when disabled', () => {
		const {analyticsPath, recorder} = recorderIn(false);

		recorder.record('mcp_tool_call', {tool: 'find_symbol', durationMs: 10});
		recorder.close();

		expect(existsSync(path.dirname(analyticsPath))).toBe(false);
	});

	it('rejects prohibited fields', () => {
		for (const field of PROHIBITED_ANALYTICS_FIELDS) {
			expect(() => assertAnalyticsFields({[field]: 'secret'})).toThrow(/prohibited/u);
		}

		expect(assertAnalyticsFields({tool: 'find_symbol', durationMs: 1})).toStrictEqual({tool: 'find_symbol', durationMs: 1});
	});

	it('rejects prohibited fields in nested objects and arrays', () => {
		expect(() => assertAnalyticsFields({metadata: {query: 'select 1'}})).toThrow(/prohibited: query/u);
		expect(() => assertAnalyticsFields({items: [{ok: true}, {absolutePath: '/secret'}]})).toThrow(/prohibited: absolutePath/u);
		expect(assertAnalyticsFields({items: [{ok: true}], nested: {tool: 'find_symbol'}})).toStrictEqual({
			items: [{ok: true}],
			nested: {tool: 'find_symbol'},
		});
	});

	it('accepts cyclic field containers without infinite recursion', () => {
		const cyclic: {tool: string; self?: unknown} = {tool: 'find_symbol'};
		cyclic.self = cyclic;

		expect(assertAnalyticsFields(cyclic)).toBe(cyclic);
	});

	it('parses only complete versioned events', () => {
		const event = {
			schema: 1,
			id: 'event',
			timestamp: '2026-01-01T00:00:00.000Z',
			program: 'code-index',
			programVersion: '0.1.0',
			projectId: 'project',
			workingCopyId: null,
			event: 'process_start',
		};

		expect(parseAnalyticsEvent(event)).toStrictEqual(event);
		expect(parseAnalyticsEvent({...event, schema: 2})).toBeNull();
		expect(parseAnalyticsEvent({...event, id: ''})).toBeNull();
	});
});

describe('analytics recorder retention', () => {
	afterEach(cleanupAnalytics);

	it('rotates an event file that reached the size bound', () => {
		const {analyticsPath, recorder} = recorderIn(true);
		const directoryPath = path.dirname(analyticsPath);
		mkdirSync(directoryPath, {recursive: true});
		writeFileSync(analyticsPath, '');
		truncateSync(analyticsPath, 10 * 1024 * 1024);

		recorder.record('process_start', {});
		recorder.close();

		const rotated = readdirSync(directoryPath).filter((name) => /^events-\d+\.jsonl$/u.test(name));

		expect(rotated).toHaveLength(1);
		expect(readFileSync(analyticsPath, 'utf8')).toContain('process_start');
	});

	it('returns null when the analytics destination cannot be written', () => {
		const {analyticsPath, recorder} = recorderIn(true);
		mkdirSync(analyticsPath, {recursive: true});

		expect(recorder.record('process_start', {})).toBeNull();
		recorder.close();
	});

	it('ignores unreadable entries and prunes surplus recent files', () => {
		const {analyticsPath, recorder} = recorderIn(true);
		const directoryPath = path.dirname(analyticsPath);
		mkdirSync(directoryPath, {recursive: true});
		symlinkSync(path.join(directoryPath, 'missing.jsonl'), path.join(directoryPath, 'broken.jsonl'));

		for (let index = 0; index < 12; index += 1) {
			writeFileSync(path.join(directoryPath, `recent-${String(index)}.jsonl`), '');
		}

		recorder.close();

		expect(readdirSync(directoryPath)).toContain('broken.jsonl');
		expect(readdirSync(directoryPath).filter((name) => name.startsWith('recent-'))).toHaveLength(10);
	});

	it('retains at most ten rotated files and removes old ones', () => {
		const {analyticsPath, recorder} = recorderIn(true);
		const directoryPath = path.dirname(analyticsPath);
		mkdirSync(directoryPath, {recursive: true});
		const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

		for (let index = 0; index < 12; index += 1) {
			const filePath = path.join(directoryPath, `events-${index}.jsonl`);
			writeFileSync(filePath, '');
			utimesSync(filePath, old, old);
		}

		recorder.record('process_start', {});
		recorder.close();

		expect(readdirSync(directoryPath).filter((name) => name.endsWith('.jsonl')).length).toBeLessThanOrEqual(10);
	});
});
