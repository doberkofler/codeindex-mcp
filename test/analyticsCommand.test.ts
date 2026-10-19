import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createAnalyticsRecorder, type AnalyticsRecorderType} from '../src/core/analytics/recorder.ts';
import {runAnalyticsCommand} from '../src/transports/cli/analyticsCommand.ts';

type CapturedIoType = Readonly<{
	io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>;
	stdout: string[];
	stderr: string[];
}>;

const capture = (): CapturedIoType => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
	};
};

describe('analytics command', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	const recorderIn = (): Readonly<{analyticsPath: string; recorder: AnalyticsRecorderType}> => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-analytics-command-'));
		const analyticsPath = path.join(directory, 'analytics', 'events.jsonl');

		return {
			analyticsPath,
			recorder: createAnalyticsRecorder({
				enabled: true,
				path: analyticsPath,
				projectId: 'project',
				program: 'code-index',
				programVersion: '0.1.0',
				workingCopyId: 'wc',
			}),
		};
	};

	it('reports the analytics path in text output', () => {
		const {analyticsPath, recorder} = recorderIn();
		const captured = capture();
		recorder.record('process_start', {});
		recorder.close();

		expect(runAnalyticsCommand(['--analytics', analyticsPath], {}, captured.io)).toBe(0);
		expect(captured.stderr).toStrictEqual([]);
		expect(captured.stdout.join('\n').split('\n')[0]).toBe(`analyticsPath: ${analyticsPath}`);
	});

	it('prints help and rejects unsupported formats', () => {
		const captured = capture();

		expect(runAnalyticsCommand(['--help'], {}, captured.io)).toBe(0);
		expect(captured.stdout.join('\n')).toContain('Usage: codeindex-cli analytics');
		expect(captured.stderr).toStrictEqual([]);

		expect(runAnalyticsCommand(['--format', 'xml'], {}, captured.io)).toBe(1);
		expect(captured.stderr).toStrictEqual(['Unsupported analytics format: xml']);
	});

	it('emits JSON and writes an HTML report', () => {
		const {analyticsPath, recorder} = recorderIn();
		const captured = capture();
		recorder.record('process_start', {});
		recorder.close();

		expect(runAnalyticsCommand(['--analytics', analyticsPath, '--format', 'json'], {}, captured.io)).toBe(0);
		expect(JSON.parse(captured.stdout.join('\n'))).toMatchObject({events: 1});

		const htmlPath = path.join(directory ?? '', 'report.html');
		captured.stdout.length = 0;
		expect(runAnalyticsCommand(['--analytics', analyticsPath, '--format', 'html', '--output', htmlPath], {}, captured.io)).toBe(0);
		expect(captured.stdout).toStrictEqual([`Analytics written to ${htmlPath}`]);
		expect(readFileSync(htmlPath, 'utf8')).toContain('<html');
	});

	it('applies configuration overrides and rejects unknown options', () => {
		const {analyticsPath, recorder} = recorderIn();
		const captured = capture();
		recorder.record('process_start', {});
		recorder.close();

		expect(
			runAnalyticsCommand(['--analytics', analyticsPath, '--config', 'config.json', '--root', '.', '--project-file', 'tsconfig.json'], {}, captured.io),
		).toBe(0);
		expect(captured.stderr).toStrictEqual([]);
		expect(captured.stdout.join('\n').split('\n')[0]).toBe(`analyticsPath: ${analyticsPath}`);

		const invalid = capture();
		expect(runAnalyticsCommand(['--unknown'], {}, invalid.io)).toBe(1);
		expect(invalid.stderr.join('\n')).toContain("unknown option '--unknown'");
	});
});
