import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {BenchmarkSuiteSchema, expandHome, loadBenchmarkSuite, resolveProjectsRoot} from '../src/core/benchmark/suiteTypes.ts';
import {runBenchmarkSuiteCommand} from '../src/core/benchmark/suite.ts';
import {failureDetail} from '../src/core/benchmark/suiteCommand.ts';
import {estimateStep, formatDuration, remainingEstimate} from '../src/core/benchmark/suiteProgress.ts';
import {benchmarkCorpusCounts} from '../src/core/benchmark/corpus.ts';
import {installCommandFor, runBenchmarkPrepareCommand} from '../src/core/benchmark/suitePrepare.ts';

const suitePath = (name: string): string => path.resolve(import.meta.dirname, '..', 'benchmark', 'suites', `${name}.json`);

const validSuite = {
	schemaVersion: 1,
	id: 'test-suite',
	generated: [],
	referenceVerification: {enabled: false},
	publicProjects: [],
};

const capture = (): Readonly<{stdout: string[]; stderr: string[]; io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>}> => {
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

describe('benchmark suite', () => {
	it('loads the committed TypeScript generated and public-project suites', () => {
		const generated = loadBenchmarkSuite(suitePath('typescript-generated'));
		const publicProjects = loadBenchmarkSuite(suitePath('typescript-public'));

		expect(generated.id).toBe('typescript-generated');
		expect(generated.generated.map((entry) => entry.profile)).toStrictEqual(['large', 'xl']);
		expect(generated.referenceVerification).toBeUndefined();
		expect(publicProjects.publicProjects.map((project) => project.name)).toStrictEqual(['typescript', 'vscode', 'material-ui']);

		for (const project of publicProjects.publicProjects) {
			expect(project.revision).toMatch(/^[0-9a-f]{40}$/u);
			expect(project.scenarios).not.toContain('edit');
		}
	});

	it('rejects an unpinned public revision', () => {
		const result = BenchmarkSuiteSchema.safeParse({
			...validSuite,
			publicProjects: [
				{
					name: 'example',
					repository: 'https://example.com/example.git',
					revision: 'main',
					directory: 'example',
					projectFile: 'tsconfig.json',
				},
			],
		});

		expect(result.success).toBe(false);
	});

	it('rejects edit scenarios for public projects', () => {
		const result = BenchmarkSuiteSchema.safeParse({
			...validSuite,
			publicProjects: [
				{
					name: 'example',
					repository: 'https://example.com/example.git',
					revision: '0'.repeat(40),
					directory: 'example',
					projectFile: 'tsconfig.json',
					scenarios: ['cold', 'edit'],
				},
			],
		});

		expect(result.success).toBe(false);
	});

	it('rejects first-run references without a baseline', () => {
		const result = BenchmarkSuiteSchema.safeParse({
			...validSuite,
			generated: [{profile: 'large', runs: 2, reference: 'first-run'}],
		});

		expect(result.success).toBe(false);
	});

	it('rejects duplicate generated profiles', () => {
		const result = BenchmarkSuiteSchema.safeParse({
			...validSuite,
			generated: [{profile: 'large'}, {profile: 'large'}],
		});

		expect(result.success).toBe(false);
	});

	it('expands home-relative project roots', () => {
		expect(expandHome('~/projects', '/home/user')).toBe(path.join('/home/user', 'projects'));
		expect(expandHome('/absolute/projects', '/home/user')).toBe('/absolute/projects');

		const suite = loadBenchmarkSuite(suitePath('typescript-public'));

		expect(resolveProjectsRoot(suite, undefined, '/home/user', '/repo')).toBe(
			path.resolve('/repo', path.join('/home/user', '.cache', 'codeindex-benchmark', 'projects')),
		);
		expect(resolveProjectsRoot(suite, 'checkouts', '/home/user', '/repo')).toBe(path.resolve('/repo', 'checkouts'));
	});

	it('extracts the error line from a crash trailer', () => {
		const crash = ['at x', 'Error: database is locked', '  code: ERR_SQLITE_ERROR', 'Node.js v26.10.0', ''].join('\n');
		const plain = ['first', 'second', 'third', 'fourth', ''].join('\n');

		expect(failureDetail(crash)).toBe('Error: database is locked');
		expect(failureDetail(plain)).toBe('second third fourth');
	});

	it('prints suite and prepare help without starting work', async () => {
		const suiteIo = capture();
		const prepareIo = capture();

		await expect(runBenchmarkSuiteCommand(['--suite', 'missing.json', '--', '--help'], {}, suiteIo.io, {cliPath: '/missing/cli.mjs'})).resolves.toBe(0);
		expect(suiteIo.stdout.join('\n')).toContain('benchmark-suite');
		expect(suiteIo.stderr).toStrictEqual([]);
		expect(runBenchmarkPrepareCommand(['--suite', 'missing.json', '--', '--help'], prepareIo.io)).toBe(0);
		expect(prepareIo.stdout.join('\n')).toContain('benchmark-prepare');
		expect(prepareIo.stderr).toStrictEqual([]);
	});
});

describe('benchmark suite preparation', () => {
	it('selects lockfile commands without running lifecycle scripts', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'code-index-prepare-'));

		try {
			expect(installCommandFor(directory)).toBeNull();

			writeFileSync(path.join(directory, 'package-lock.json'), '{}\n', {encoding: 'utf8'});
			expect(installCommandFor(directory)).toStrictEqual({command: 'npm', args: ['ci', '--ignore-scripts']});
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}

		const pnpmDirectory = mkdtempSync(path.join(tmpdir(), 'code-index-prepare-'));
		const yarnClassicDirectory = mkdtempSync(path.join(tmpdir(), 'code-index-prepare-'));
		const yarnBerryDirectory = mkdtempSync(path.join(tmpdir(), 'code-index-prepare-'));

		try {
			writeFileSync(path.join(pnpmDirectory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', {encoding: 'utf8'});
			writeFileSync(path.join(yarnClassicDirectory, 'yarn.lock'), '# yarn lockfile v1\n', {encoding: 'utf8'});
			writeFileSync(path.join(yarnBerryDirectory, 'yarn.lock'), '__metadata:\n', {encoding: 'utf8'});
			writeFileSync(path.join(yarnBerryDirectory, '.yarnrc.yml'), 'nodeLinker: node-modules\n', {encoding: 'utf8'});

			expect(installCommandFor(pnpmDirectory)).toStrictEqual({
				command: 'pnpm',
				args: ['install', '--frozen-lockfile', '--ignore-scripts'],
			});
			expect(installCommandFor(yarnClassicDirectory)).toStrictEqual({
				command: 'yarn',
				args: ['install', '--frozen-lockfile', '--ignore-scripts'],
			});
			expect(installCommandFor(yarnBerryDirectory)).toStrictEqual({
				command: 'yarn',
				args: ['install', '--immutable'],
				env: {YARN_ENABLE_SCRIPTS: 'false'},
			});
		} finally {
			for (const temporaryDirectory of [pnpmDirectory, yarnClassicDirectory, yarnBerryDirectory]) {
				rmSync(temporaryDirectory, {recursive: true, force: true});
			}
		}
	});
});

describe('benchmark suite progress', () => {
	it('formats durations for progress output', () => {
		expect(formatDuration(950)).toBe('1s');
		expect(formatDuration(59_400)).toBe('59s');
		expect(formatDuration(60_000)).toBe('1m 00s');
		expect(formatDuration(71_200)).toBe('1m 11s');
	});

	it('scales estimates across generated profiles and sums remaining work', () => {
		const large = {id: 'generated:large:run:01', kind: 'generated' as const};
		const xl = {id: 'generated:xl:run:01', kind: 'generated' as const};
		const history = new Map<string, number[]>([['generated:large:run', [20_000]]]);
		const expected = (20_000 * benchmarkCorpusCounts('xl').fileCount) / benchmarkCorpusCounts('large').fileCount;

		expect(estimateStep(large, history)).toBe(20_000);
		expect(estimateStep(xl, history)).toBeCloseTo(expected);
		expect(remainingEstimate([large, xl], history)).toBeCloseTo(20_000 + expected);
		expect(estimateStep({id: 'public:vscode:run:01', kind: 'public'}, history)).toBeNull();
		expect(estimateStep(large, new Map([['generated:large:cold', [2000]]]))).toBe(20_000);
	});
});
