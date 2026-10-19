import {describe, expect, it} from 'vitest';
import {parseCsv} from '../src/core/qualification/oracle/oracleCsv.ts';
import {runQualifyCommand, type QualifyIoType} from '../src/core/qualification/qualifyCommand.ts';

type CapturedIoType = Readonly<{io: QualifyIoType; stdout: () => string; stderr: () => string}>;

const capture = (): CapturedIoType => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
		stdout: () => stdout.join('\n'),
		stderr: () => stderr.join('\n'),
	};
};

describe('qualification command', () => {
	it('prints adapter-neutral help', async () => {
		const captured = capture();

		await expect(runQualifyCommand(['--help'], {}, captured.io)).resolves.toBe(0);
		expect(captured.stdout()).toContain('--extractor <id>');
		expect(captured.stdout()).toContain('--units <path>');
		expect(captured.stdout()).toContain('--truth-policy <version>');
		expect(captured.stdout()).toContain('--parser <parser>');
		expect(captured.stderr()).toBe('');
	});

	it('rejects unknown extractors', async () => {
		const captured = capture();

		await expect(runQualifyCommand(['--extractor', 'unknown'], {}, captured.io)).resolves.toBe(1);
		expect(captured.stderr()).toContain('Unknown qualification extractor: unknown');
	});

	it('requires Oracle truth exports', async () => {
		const captured = capture();

		await expect(runQualifyCommand(['--extractor', 'oracle'], {}, captured.io)).resolves.toBe(1);
		expect(captured.stderr()).toContain('Oracle qualification requires --identifiers and --dependencies');
	});

	it('parses quoted CSV fields', () => {
		expect(parseCsv('a,"b,c","d""e"\n"line\nbreak",z\n')).toStrictEqual([
			['a', 'b,c', 'd"e'],
			['line\nbreak', 'z'],
		]);
	});
});
