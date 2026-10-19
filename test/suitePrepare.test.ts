import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runBenchmarkPrepareCommand} from '../src/core/benchmark/suitePrepare.ts';

const doubles = vi.hoisted(() => ({
	spawnSync: vi.fn<(...args: unknown[]) => {status: number}>(),
	git: vi.fn<(directory: string, args: readonly string[]) => string | null>(),
	lockfileOf: vi.fn<(directory: string) => string | null>(),
	sha256File: vi.fn<(filePath: string) => string>(),
	loadBenchmarkSuite: vi.fn<(filePath: string) => unknown>(),
	resolveProjectsRoot: vi.fn<(suite: unknown, override: string | undefined, home: string, cwd: string) => string>(),
}));

vi.mock(import('node:child_process'), () => ({spawnSync: doubles.spawnSync as never}));
vi.mock(import('../src/core/benchmark/suiteManifest.ts'), () => ({
	git: doubles.git,
	lockfileOf: doubles.lockfileOf,
	sha256File: doubles.sha256File,
}));
vi.mock(import('../src/core/benchmark/suiteTypes.ts'), () => ({
	loadBenchmarkSuite: doubles.loadBenchmarkSuite as never,
	resolveProjectsRoot: doubles.resolveProjectsRoot as never,
}));

type PublicProjectType = Readonly<{
	name: string;
	repository: string;
	revision: string;
	directory: string;
	projectFile: string;
}>;

type CapturedIoType = Readonly<{
	io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>;
	stdout: string[];
	stderr: string[];
}>;

const revisionOf = (name: string): string => name.repeat(40).slice(0, 40);

const projectOf = (name: string): PublicProjectType => ({
	name,
	repository: `https://example.com/${name}.git`,
	revision: revisionOf(name),
	directory: name,
	projectFile: 'tsconfig.json',
});

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

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-suite-prepare-'));
	temporaryDirectories.push(directory);
	return directory;
};

const manifestOf = (projectsRoot: string): {projects: readonly {name: string; lockfile: string | null; lockfileSha256: string | null}[]} =>
	JSON.parse(readFileSync(path.join(projectsRoot, 'prepare.json'), 'utf8')) as {
		projects: readonly {name: string; lockfile: string | null; lockfileSha256: string | null}[];
	};

const cleanupTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

const resetPreparation = (): void => {
	vi.resetAllMocks();
	doubles.spawnSync.mockReturnValue({status: 0});
	doubles.git.mockImplementation((_directory: string, args: readonly string[]) => (args[0] === 'rev-parse' ? 'alpha'.repeat(8) : null));
	doubles.lockfileOf.mockReturnValue(null);
	doubles.sha256File.mockReturnValue('sha');
	doubles.resolveProjectsRoot.mockImplementation((_suite: unknown, _override: string | undefined, _home: string, cwd: string) => path.join(cwd, 'projects'));
};

describe('benchmark suite preparation cloning', () => {
	beforeEach(resetPreparation);
	afterEach(cleanupTemporaryDirectories);

	it('clones, reuses, installs, and records prepared projects', () => {
		const root = temporaryDirectory();
		const projectsRoot = path.join(root, 'projects');
		const beta = path.join(projectsRoot, 'beta');
		const gamma = path.join(projectsRoot, 'gamma');
		const alpha = projectOf('alpha');
		const betaProject = projectOf('beta');
		const gammaProject = projectOf('gamma');

		mkdirSync(beta, {recursive: true});
		writeFileSync(path.join(beta, 'package-lock.json'), '{}\n', {encoding: 'utf8'});
		mkdirSync(gamma, {recursive: true});
		writeFileSync(path.join(gamma, 'yarn.lock'), '# yarn\n', {encoding: 'utf8'});
		writeFileSync(path.join(gamma, '.yarnrc.yml'), 'nodeLinker: node-modules\n', {encoding: 'utf8'});

		doubles.git.mockImplementation((directory: string) => (directory === beta ? betaProject.revision : gammaProject.revision));
		doubles.lockfileOf.mockImplementation((directory: string) => {
			if (directory === beta) {
				return path.join(directory, 'package-lock.json');
			}

			return directory === gamma ? path.join(directory, 'yarn.lock') : null;
		});
		doubles.sha256File.mockReturnValue('recorded-hash');
		doubles.loadBenchmarkSuite.mockReturnValue({publicProjects: [alpha, betaProject, gammaProject]});
		const captured = capture();

		const code = runBenchmarkPrepareCommand(['--suite', path.join(root, 'suite.json'), '--projects-root', projectsRoot], captured.io, {
			cwd: root,
			home: '/home/user',
		});

		expect(code).toBe(0);
		expect(captured.stderr).toStrictEqual(['No supported lockfile found for alpha; skipping dependency installation']);
		expect(captured.stdout).toContain(`[clone] https://example.com/alpha.git -> ${path.join(projectsRoot, 'alpha')}`);
		expect(captured.stdout).toContain(`[reuse] beta at ${betaProject.revision}`);
		expect(captured.stdout).toContain(`[install] npm ci --ignore-scripts (beta)`);
		expect(captured.stdout).toContain('[install] yarn install --immutable (gamma)');
		expect(doubles.spawnSync).toHaveBeenCalledWith('git', ['clone', '--filter=blob:none', alpha.repository, path.join(projectsRoot, 'alpha')], {
			stdio: 'inherit',
		});
		expect(doubles.spawnSync).toHaveBeenCalledWith('git', ['-C', path.join(projectsRoot, 'alpha'), 'checkout', alpha.revision], {stdio: 'inherit'});
		expect(doubles.spawnSync).toHaveBeenCalledWith('npm', ['ci', '--ignore-scripts'], {cwd: beta, stdio: 'inherit'});
		expect(doubles.spawnSync).toHaveBeenCalledWith('yarn', ['install', '--immutable'], {
			cwd: gamma,
			stdio: 'inherit',
			env: expect.objectContaining({YARN_ENABLE_SCRIPTS: 'false'}),
		});
		expect(doubles.resolveProjectsRoot).toHaveBeenCalledWith({publicProjects: [alpha, betaProject, gammaProject]}, projectsRoot, '/home/user', root);
		expect(manifestOf(projectsRoot).projects).toMatchObject([
			{name: 'alpha', lockfile: null, lockfileSha256: null},
			{name: 'beta', lockfile: 'package-lock.json', lockfileSha256: 'recorded-hash'},
			{name: 'gamma', lockfile: 'yarn.lock', lockfileSha256: 'recorded-hash'},
		]);
	});
});

describe('benchmark suite preparation validation', () => {
	beforeEach(resetPreparation);
	afterEach(cleanupTemporaryDirectories);

	it('skips installation when requested', () => {
		const root = temporaryDirectory();
		const projectsRoot = path.join(root, 'projects');
		const alpha = projectOf('alpha');

		mkdirSync(path.join(projectsRoot, 'alpha'), {recursive: true});
		doubles.git.mockReturnValue(alpha.revision);
		doubles.loadBenchmarkSuite.mockReturnValue({publicProjects: [alpha]});
		const captured = capture();

		expect(runBenchmarkPrepareCommand(['--suite', 'suite.json', '--projects-root', projectsRoot, '--skip-install'], captured.io, {cwd: root})).toBe(0);

		expect(captured.stderr).toStrictEqual([]);
		expect(doubles.spawnSync).not.toHaveBeenCalled();
	});

	it('skips unsupported lockfiles and reports the reason', () => {
		const root = temporaryDirectory();
		const projectsRoot = path.join(root, 'projects');
		const alpha = projectOf('alpha');

		mkdirSync(path.join(projectsRoot, 'alpha'), {recursive: true});
		doubles.git.mockReturnValue(alpha.revision);
		doubles.loadBenchmarkSuite.mockReturnValue({publicProjects: [alpha]});
		const captured = capture();

		expect(runBenchmarkPrepareCommand(['--suite', 'suite.json', '--projects-root', projectsRoot], captured.io, {cwd: root})).toBe(0);

		expect(captured.stderr).toStrictEqual(['No supported lockfile found for alpha; skipping dependency installation']);
	});

	it('rejects an existing checkout at another revision', () => {
		const root = temporaryDirectory();
		const projectsRoot = path.join(root, 'projects');
		const alpha = projectOf('alpha');

		mkdirSync(path.join(projectsRoot, 'alpha'), {recursive: true});
		doubles.git.mockReturnValue('other'.repeat(8));
		doubles.loadBenchmarkSuite.mockReturnValue({publicProjects: [alpha]});
		const captured = capture();

		expect(runBenchmarkPrepareCommand(['--suite', 'suite.json', '--projects-root', projectsRoot], captured.io, {cwd: root})).toBe(1);
		expect(captured.stderr).toStrictEqual([expect.stringContaining('remove')]);
	});

	it('reports clone and checkout failures', () => {
		const root = temporaryDirectory();
		const projectsRoot = path.join(root, 'projects');
		const alpha = projectOf('alpha');

		doubles.loadBenchmarkSuite.mockReturnValue({publicProjects: [alpha]});
		doubles.spawnSync.mockReturnValueOnce({status: 1});
		const cloneFailure = capture();

		expect(runBenchmarkPrepareCommand(['--suite', 'suite.json', '--projects-root', projectsRoot], cloneFailure.io, {cwd: root})).toBe(1);
		expect(cloneFailure.stderr).toStrictEqual([`Failed to clone ${alpha.repository}`]);

		doubles.spawnSync.mockReset();
		doubles.spawnSync.mockReturnValueOnce({status: 0}).mockReturnValueOnce({status: 1});
		const checkoutFailure = capture();

		expect(runBenchmarkPrepareCommand(['--suite', 'suite.json', '--projects-root', projectsRoot], checkoutFailure.io, {cwd: root})).toBe(1);
		expect(checkoutFailure.stderr).toStrictEqual([`Failed to check out ${alpha.revision} in ${path.join(projectsRoot, 'alpha')}`]);
	});

	it('reports installation and suite loading failures', () => {
		const root = temporaryDirectory();
		const projectsRoot = path.join(root, 'projects');
		const alpha = projectOf('alpha');
		const beta = projectOf('beta');

		mkdirSync(path.join(projectsRoot, 'alpha'), {recursive: true});
		mkdirSync(path.join(projectsRoot, 'beta'), {recursive: true});
		writeFileSync(path.join(projectsRoot, 'alpha', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', {encoding: 'utf8'});

		doubles.git.mockImplementation((directory: string) => (directory.endsWith('alpha') ? alpha.revision : beta.revision));
		doubles.loadBenchmarkSuite.mockReturnValue({publicProjects: [alpha, beta]});
		doubles.spawnSync.mockReturnValueOnce({status: 1});
		const installFailure = capture();

		expect(runBenchmarkPrepareCommand(['--suite', 'suite.json', '--projects-root', projectsRoot], installFailure.io, {cwd: root})).toBe(1);
		expect(installFailure.stderr).toStrictEqual([`pnpm install --frozen-lockfile --ignore-scripts failed for alpha`]);

		doubles.loadBenchmarkSuite.mockImplementationOnce(() => {
			throw new Error('Invalid benchmark suite');
		});
		const loadFailure = capture();

		expect(runBenchmarkPrepareCommand(['--suite', 'broken.json'], loadFailure.io, {cwd: root})).toBe(1);
		expect(loadFailure.stderr).toStrictEqual(['Invalid benchmark suite']);
	});
});
