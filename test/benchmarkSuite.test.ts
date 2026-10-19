import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {BenchmarkSuiteSchema, expandHome, loadBenchmarkSuite, resolveProjectsRoot} from '../src/core/benchmark/suiteTypes.ts';
import {runBenchmarkSuiteCommand} from '../src/core/benchmark/suite.ts';
import {runBenchmarkPrepareCommand} from '../src/core/benchmark/suitePrepare.ts';

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
	it('loads the committed reference and public-project suites', () => {
		const reference = loadBenchmarkSuite(suitePath('reference'));
		const publicProjects = loadBenchmarkSuite(suitePath('public-projects'));

		expect(reference.id).toBe('reference-workstation');
		expect(reference.generated.map((entry) => entry.profile)).toStrictEqual(['large', 'xl']);
		expect(reference.referenceVerification?.enabled).toBe(true);
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

		const suite = loadBenchmarkSuite(suitePath('public-projects'));

		expect(resolveProjectsRoot(suite, undefined, '/home/user', '/repo')).toBe(
			path.resolve('/repo', path.join('/home/user', '.cache', 'codeindex-benchmark', 'projects')),
		);
		expect(resolveProjectsRoot(suite, 'checkouts', '/home/user', '/repo')).toBe(path.resolve('/repo', 'checkouts'));
	});

	it('prints suite and prepare help without starting work', () => {
		const suiteIo = capture();
		const prepareIo = capture();

		expect(runBenchmarkSuiteCommand(['--suite', 'missing.json', '--', '--help'], {}, suiteIo.io, {cliPath: '/missing/cli.mjs'})).toBe(0);
		expect(suiteIo.stdout.join('\n')).toContain('benchmark-suite');
		expect(suiteIo.stderr).toStrictEqual([]);
		expect(runBenchmarkPrepareCommand(['--suite', 'missing.json', '--', '--help'], prepareIo.io)).toBe(0);
		expect(prepareIo.stdout.join('\n')).toContain('benchmark-prepare');
		expect(prepareIo.stderr).toStrictEqual([]);
	});
});
