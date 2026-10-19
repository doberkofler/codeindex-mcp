import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runBenchmarkSuiteCommand} from '../src/core/benchmark/suite.ts';
import {resolveStepPaths} from '../src/core/benchmark/suiteSteps.ts';
import {BenchmarkSuiteSchema} from '../src/core/benchmark/suiteTypes.ts';

const {join} = path;
const temporaryDirectories: string[] = [];

const fakeCli = (): string => `
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const value = (name) => {
	const index = argv.indexOf(name);
	return index === -1 ? null : argv[index + 1];
};
const workspace = value('--workspace');
if (workspace !== null) {
	mkdirSync(workspace, {recursive: true});
	writeFileSync(path.join(workspace, 'marker.txt'), 'work');
}



if (process.env.FAKE_CLI_FAIL === '1') {
	process.stderr.write('warning line\\nError: fake benchmark step failed\\n');
	process.exit(1);
}

const output = value('--output');
if (output !== null) {
	mkdirSync(path.dirname(output), {recursive: true});
	writeFileSync(output, JSON.stringify({
		workspace: {kind: 'generated', profile: 'large', fileCount: 2, symbolCount: 3, occurrenceCount: 4},
		scenarios: [
			{name: 'warm', kind: 'warm', wallMs: 12, resources: {rssPeakBytes: 1024}, storage: {totalBytes: 2048}, percentiles: {p95Ms: 3}},
			{name: 'deep', kind: 'deep', wallMs: 13, resources: {rssPeakBytes: 1024}, storage: {totalBytes: 2048}},
		],
		queries: {find_symbol: {p95Ms: 2}},
	}));
}

const summary = value('--summary');
if (summary !== null) {
	mkdirSync(path.dirname(summary), {recursive: true});
	writeFileSync(summary, '# report\\n');
}

const evaluation = value('--evaluation');
if (evaluation !== null) {
	mkdirSync(path.dirname(evaluation), {recursive: true});
	writeFileSync(evaluation, JSON.stringify({
		status: 'warning',
		summary: {pass: 1, warning: 2, failure: 0, skipped: 0},
	}));
}

process.stderr.write('[benchmark] progress line\\n');
`;

const fixture = (): Readonly<{base: string; repository: string; cliPath: string; suitePath: string}> => {
	const base = mkdtempSync(join(tmpdir(), 'code-index-suite-'));
	temporaryDirectories.push(base);
	const repository = join(base, 'repository');
	const cliPath = join(repository, 'cli.mjs');
	mkdirSync(repository, {recursive: true});
	writeFileSync(join(repository, 'baseline.json'), '{}\n', {encoding: 'utf8'});
	writeFileSync(cliPath, fakeCli(), {encoding: 'utf8'});

	const suitePath = join(repository, 'suite.json');
	writeFileSync(
		suitePath,
		JSON.stringify({
			schemaVersion: 1,
			id: 'generated-suite',
			generated: [
				{
					profile: 'large',
					runs: 2,
					scenarios: ['warm', 'edit'],
					baseline: 'baseline.json',
					reference: 'first-run',
					coldProcess: true,
				},
			],
		}),
		{encoding: 'utf8'},
	);

	return {base, repository, cliPath, suitePath};
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

const options = (fixtureValue: ReturnType<typeof fixture>): Readonly<{cliPath: string; cwd: string; home: string}> => ({
	cliPath: fixtureValue.cliPath,
	cwd: fixtureValue.repository,
	home: fixtureValue.base,
});

const removeTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('benchmark suite execution', () => {
	afterEach(removeTemporaryDirectories);

	it('runs generated, cold-process, and first-run reference steps and resumes passed work', async () => {
		const fixtureValue = fixture();
		const output = join(fixtureValue.base, 'evidence');
		const first = capture();
		const environment: NodeJS.ProcessEnv = process.env;

		await expect(
			runBenchmarkSuiteCommand(['--suite', fixtureValue.suitePath, '--output', output, '--iterations', '2'], environment, first.io, options(fixtureValue)),
		).resolves.toBe(0);

		expect(first.stderr).toStrictEqual([]);
		expect(first.stdout.join('\n')).toContain('generated:large:cold:01');
		expect(first.stdout).toContain('       [benchmark] progress line');
		expect(first.stdout.join('\n')).toContain('Status: passed');

		const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as {status: string; steps: {id: string}[]};
		expect(manifest.status).toBe('passed');
		expect(manifest.steps.map((step) => step.id)).toStrictEqual([
			'generated:large:cold:01',
			'generated:large:run:01',
			'generated:large:cold:02',
			'generated:large:run:02',
		]);
		expect(existsSync(join(output, 'summary.md'))).toBe(true);
		expect(readFileSync(join(output, 'summary.md'), 'utf8')).toContain('## Measurements');
		expect(existsSync(join(output, 'checksums.sha256'))).toBe(true);
		expect(existsSync(join(output, 'work'))).toBe(false);

		const resumed = capture();
		await expect(
			runBenchmarkSuiteCommand(['--suite', fixtureValue.suitePath, '--output', output, '--resume'], environment, resumed.io, options(fixtureValue)),
		).resolves.toBe(0);
		expect(resumed.stdout.join('\n')).toContain('(resume)');
	});

	it('retains the workspace and reports step failures', async () => {
		const fixtureValue = fixture();
		const output = join(fixtureValue.base, 'failed-evidence');
		const captured = capture();
		const environment: NodeJS.ProcessEnv = {...process.env, FAKE_CLI_FAIL: '1'};

		await expect(
			runBenchmarkSuiteCommand(
				['--suite', fixtureValue.suitePath, '--output', output, '--keep-workspace', '--fail-fast'],
				environment,
				captured.io,
				options(fixtureValue),
			),
		).resolves.toBe(1);

		expect(captured.stderr).toContain('Error: fake benchmark step failed');
		expect(captured.stdout.join('\n')).toContain('Status: failed');
		expect(existsSync(join(output, 'work'))).toBe(true);

		const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as {status: string; steps: {status: string; detail: string | null}[]};
		expect(manifest.status).toBe('failed');
		expect(manifest.steps).toHaveLength(1);
		expect(manifest.steps[0]?.detail).toBe('Error: fake benchmark step failed');
	});
});

describe('benchmark suite validation', () => {
	afterEach(removeTemporaryDirectories);

	it('rejects invalid options and unsafe evidence directories', async () => {
		const fixtureValue = fixture();
		const environment: NodeJS.ProcessEnv = process.env;
		const missingBaselineSuite = join(fixtureValue.repository, 'missing-baseline.json');
		const invalidIterations = capture();
		const missingCli = capture();
		const inside = capture();
		const missingResume = capture();
		const nonEmpty = capture();
		const missingBaseline = capture();
		const output = join(fixtureValue.base, 'evidence-errors');
		const nonEmptyOutput = join(fixtureValue.base, 'non-empty');
		mkdirSync(nonEmptyOutput, {recursive: true});
		writeFileSync(join(nonEmptyOutput, 'existing.txt'), 'x');
		writeFileSync(
			missingBaselineSuite,
			JSON.stringify({
				schemaVersion: 1,
				id: 'missing-baseline',
				generated: [{profile: 'small', baseline: 'absent.json'}],
			}),
		);

		await expect(
			runBenchmarkSuiteCommand(
				['--suite', fixtureValue.suitePath, '--output', output, '--iterations', '0'],
				environment,
				invalidIterations.io,
				options(fixtureValue),
			),
		).resolves.toBe(1);
		expect(invalidIterations.stderr.join('\n')).toContain('--iterations must be an integer');

		await expect(
			runBenchmarkSuiteCommand(['--suite', fixtureValue.suitePath, '--output', output], environment, missingCli.io, {
				...options(fixtureValue),
				cliPath: join(fixtureValue.base, 'missing.mjs'),
			}),
		).resolves.toBe(1);
		expect(missingCli.stderr.join('\n')).toContain('CLI bundle not found');

		await expect(
			runBenchmarkSuiteCommand(
				['--suite', fixtureValue.suitePath, '--output', join(fixtureValue.repository, 'evidence')],
				environment,
				inside.io,
				options(fixtureValue),
			),
		).resolves.toBe(1);
		expect(inside.stderr.join('\n')).toContain('Evidence directory must be outside the repository');

		await expect(
			runBenchmarkSuiteCommand(['--suite', fixtureValue.suitePath, '--output', output, '--resume'], environment, missingResume.io, options(fixtureValue)),
		).resolves.toBe(1);
		expect(missingResume.stderr.join('\n')).toContain('Cannot resume: manifest.json not found');

		await expect(
			runBenchmarkSuiteCommand(['--suite', fixtureValue.suitePath, '--output', nonEmptyOutput], environment, nonEmpty.io, options(fixtureValue)),
		).resolves.toBe(1);
		expect(nonEmpty.stderr.join('\n')).toContain('Output directory is not empty');

		await expect(
			runBenchmarkSuiteCommand(['--suite', missingBaselineSuite, '--output', output], environment, missingBaseline.io, options(fixtureValue)),
		).resolves.toBe(1);
		expect(missingBaseline.stderr.join('\n')).toContain('Baseline not found');
	});
});

describe('benchmark suite step planning', () => {
	afterEach(removeTemporaryDirectories);

	it('expands cold, repeated, public, and reference steps', () => {
		const suite = BenchmarkSuiteSchema.parse({
			schemaVersion: 1,
			id: 'planning',
			generated: [
				{
					profile: 'large',
					runs: 2,
					scenarios: ['warm', 'edit'],
					baseline: 'baseline.json',
					reference: 'first-run',
					coldProcess: true,
				},
			],
			publicProjects: [
				{
					name: 'example',
					repository: 'https://example.com/example.git',
					revision: '0'.repeat(40),
					directory: 'example',
					projectFile: 'tsconfig.json',
					scenarios: ['cold', 'warm'],
					baseline: 'baseline.json',
					reference: 'first-run',
					runs: 2,
				},
			],
			referenceVerification: {enabled: true, root: 'src', projectFile: 'tsconfig.json'},
		});
		const steps = resolveStepPaths({suite, repositoryRoot: '/repo', outputDir: '/evidence', projectsRoot: '/projects'});
		const ids = steps.map((step) => step.id);

		expect(ids).toStrictEqual([
			'generated:large:cold:01',
			'generated:large:run:01',
			'generated:large:cold:02',
			'generated:large:run:02',
			'public:example:run:01',
			'public:example:run:02',
			'reference:typescript',
		]);

		const generatedRun = steps.at(1);
		const publicRun = steps.at(5);
		const reference = steps.at(6);

		if (generatedRun === undefined || publicRun === undefined || reference === undefined) {
			throw new Error('Expected generated, public, and reference steps');
		}

		const generatedArgs = generatedRun.args({
			cliPath: '/cli.mjs',
			baselinePath: generatedRun.baselinePath,
			referencePath: '/evidence/generated/large/run-01.json',
		});

		expect(generatedArgs).toContain('--baseline');
		expect(generatedArgs).toContain('--reference');
		expect(generatedArgs).toContain('warm,edit');

		const publicArgs = publicRun.args({
			cliPath: '/cli.mjs',
			baselinePath: publicRun.baselinePath,
			referencePath: '/evidence/public/example/run-01.json',
		});

		expect(publicArgs).toContain('--root');
		expect(publicArgs).toContain('--reference');

		expect(reference.environment).toStrictEqual({
			CODE_INDEX_ROOT: '/repo/src',
			CODE_INDEX_PROJECT_FILE: '/repo/src/tsconfig.json',
			CODE_INDEX_DATABASE: '/evidence/tmp/reference-verification.sqlite',
		});
		expect(reference.args({cliPath: '/cli.mjs', baselinePath: null, referencePath: null})).toStrictEqual(['/cli.mjs', 'qualify', '--extractor', 'typescript']);
	});

	it('omits reference verification when disabled', () => {
		const suite = BenchmarkSuiteSchema.parse({
			schemaVersion: 1,
			id: 'single',
			generated: [{profile: 'small'}],
		});

		const steps = resolveStepPaths({suite, repositoryRoot: '/repo', outputDir: '/evidence', projectsRoot: '/projects'});

		expect(steps.map((step) => step.id)).toStrictEqual(['generated:small:run:01']);
		expect(steps[0]?.args({cliPath: '/cli.mjs', baselinePath: null, referencePath: null})).not.toContain('--baseline');
	});
});
