import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {assertAnalyticsFields, PROHIBITED_ANALYTICS_FIELDS} from '../src/analytics/events.ts';
import {createAnalyticsRecorder, type AnalyticsRecorderType} from '../src/analytics/recorder.ts';
import {summarizeAnalytics} from '../src/analytics/report.ts';
import {runAnalyticsCommand} from '../src/cli/analyticsCommand.ts';

describe('analytics', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

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

	it('reports the analytics path in text output', () => {
		const {analyticsPath, recorder} = recorderIn(true);
		const stdout: string[] = [];
		const stderr: string[] = [];
		recorder.record('process_start', {});
		recorder.close();

		const exitCode = runAnalyticsCommand(
			['--analytics', analyticsPath],
			{},
			{
				stdout: (line) => {
					stdout.push(line);
				},
				stderr: (line) => {
					stderr.push(line);
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(stderr).toStrictEqual([]);
		expect(stdout.join('\n').split('\n')[0]).toBe(`analyticsPath: ${analyticsPath}`);
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
