import {describe, expect, it} from 'vitest';
import {runCli, type CliIoType} from '../src/cli/runCli.ts';
import {PROGRAM_VERSION} from '../src/version.ts';
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

	it('prints help and rejects invalid commands', async () => {
		const environment: NodeJS.ProcessEnv = {CODE_INDEX_ROOT: '.', CODE_INDEX_LOG_LEVEL: 'error'};
		const help = captureIo();

		await expect(runCli(['--help'], environment, help.io)).resolves.toBe(0);
		expect(help.stdout()).toContain('Operational commands');

		const invalid = captureIo();
		await expect(runCli(['explode'], environment, invalid.io)).resolves.toBe(2);
		expect(invalid.stderr()).toContain("unknown command 'explode'");
	});
});
