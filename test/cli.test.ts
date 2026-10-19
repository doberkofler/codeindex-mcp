import {describe, expect, it} from 'vitest';
import {runCli, type CliIoType} from '../src/transports/cli/runCli.ts';
import {PROGRAM_VERSION} from '../src/core/version.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

type CapturedIoType = Readonly<{io: CliIoType; stdout: () => string; stderr: () => string}>;

const captureIo = (): CapturedIoType => {
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

describe('operational CLI', () => {
	it('builds, reuses, force-rebuilds, reports status, and verifies', async () => {
		const {config, cleanup} = createFixtureConfig('simple-project');
		const environment: NodeJS.ProcessEnv = {
			CODE_INDEX_ROOT: config.rootDir,
			CODE_INDEX_PROJECT_FILE: config.projectFilePath,
			CODE_INDEX_DATABASE: config.databasePath,
			CODE_INDEX_LOG_LEVEL: 'error',
		};

		try {
			const first = captureIo();
			await expect(runCli(['update', '--json'], environment, first.io)).resolves.toBe(0);
			expect(JSON.parse(first.stdout())).toMatchObject({reused: false, fileCount: 4});

			const second = captureIo();
			await expect(runCli(['update', '--json'], environment, second.io)).resolves.toBe(0);
			expect(JSON.parse(second.stdout())).toMatchObject({reused: true, fileCount: 4});

			const forced = captureIo();
			await expect(runCli(['rebuild', '--json'], environment, forced.io)).resolves.toBe(0);
			expect(JSON.parse(forced.stdout())).toMatchObject({reused: false, fileCount: 4});

			const status = captureIo();
			await expect(runCli(['status', '--json'], environment, status.io)).resolves.toBe(0);
			expect(JSON.parse(status.stdout())).toMatchObject({
				ready: true,
				state: 'published',
				counts: {files: 4},
				freshness: {staleFiles: 0, sourceChanged: false},
			});

			const human = captureIo();
			await expect(runCli(['status'], environment, human.io)).resolves.toBe(0);
			expect(human.stdout().split('\n')[0]).toBe(`codeindex-mcp ${PROGRAM_VERSION} (status)`);

			const verify = captureIo();
			await expect(runCli(['verify', '--json'], environment, verify.io)).resolves.toBe(0);
			expect(JSON.parse(verify.stdout())).toMatchObject({integrity: 'ok', metadataMatches: true});
		} finally {
			cleanup();
		}
	});

	it('dispatches special commands through their adapters', async () => {
		const environment: NodeJS.ProcessEnv = {CODE_INDEX_ROOT: '.', CODE_INDEX_LOG_LEVEL: 'error'};
		const commands: readonly (readonly string[])[] = [
			['analytics', '--help'],
			['benchmark', '--help'],
			['benchmark-suite', '--help'],
			['benchmark-prepare', '--help'],
			['verify-references', '--help'],
		];

		const results = await Promise.all(
			commands.map(async (argv) => {
				const captured = captureIo();

				await expect(runCli(argv, environment, captured.io)).resolves.toBe(0);
				return captured;
			}),
		);

		for (const captured of results) {
			expect(captured.stdout()).toContain('Usage');
		}
	});

	it('prints command help without arguments and reports configuration failures', async () => {
		const help = captureIo();
		const failed = captureIo();

		await expect(runCli([], {CODE_INDEX_ROOT: '.', CODE_INDEX_LOG_LEVEL: 'error'}, help.io)).resolves.toBe(0);
		expect(help.stdout()).toContain('Operational commands');

		await expect(runCli(['status'], {CODE_INDEX_ROOT: '/definitely/missing-root'}, failed.io)).resolves.toBe(1);
		expect(failed.stderr()).not.toBe('');
	});

	it('prints help and rejects invalid commands', async () => {
		const environment: NodeJS.ProcessEnv = {CODE_INDEX_ROOT: '.', CODE_INDEX_LOG_LEVEL: 'error'};
		const help = captureIo();

		await expect(runCli(['--help'], environment, help.io)).resolves.toBe(0);
		expect(help.stdout()).toContain('Operational commands');

		const qualify = captureIo();
		await expect(runCli(['qualify', '--help'], environment, qualify.io)).resolves.toBe(0);
		expect(qualify.stdout()).toContain('--extractor <id>');

		const invalid = captureIo();
		await expect(runCli(['explode'], environment, invalid.io)).resolves.toBe(2);
		expect(invalid.stderr()).toContain("unknown command 'explode'");
	});
});
