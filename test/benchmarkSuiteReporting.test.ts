import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	artifactsExist,
	identityOf,
	lockfileOf,
	readManifest,
	sameIdentity,
	sha256File,
	verifyPublicProject,
	writeManifest,
	type SuiteIdentityType,
	type SuiteManifestType,
} from '../src/core/benchmark/suiteManifest.ts';
import {buildSuiteSummary} from '../src/core/benchmark/suiteSummary.ts';
import {cleanChildEnvironment, failureDetail, runCommand} from '../src/core/benchmark/suiteCommand.ts';
import {BenchmarkSuiteSchema} from '../src/core/benchmark/suiteTypes.ts';

const {join} = path;
const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'code-index-reporting-'));
	temporaryDirectories.push(directory);
	return directory;
};

const identity = (overrides: Partial<SuiteIdentityType> = {}): SuiteIdentityType => ({
	commit: 'commit',
	dirty: false,
	statusSha256: 'status',
	cliSha256: 'cli',
	version: '0.0.0',
	nodeVersion: process.version,
	sqliteVersion: '3',
	platform: process.platform,
	arch: process.arch,
	cpuModel: 'cpu',
	totalMemoryBytes: 1024,
	...overrides,
});

const manifest = (overrides: Partial<SuiteManifestType> = {}): SuiteManifestType => ({
	schemaVersion: 1,
	suite: {id: 'suite', path: 'suite.json', sha256: 'abcdef0123456789'},
	identity: identity(),
	startedAt: '2026-01-01T00:00:00.000Z',
	completedAt: '2026-01-01T00:01:00.000Z',
	status: 'passed',
	baselines: [],
	projects: [],
	steps: [],
	...overrides,
});

const step = (
	input: Readonly<{id: string; kind: 'generated' | 'public' | 'reference'; artifacts: string[]; detail?: string | null}>,
): SuiteManifestType['steps'][number] => ({
	id: input.id,
	kind: input.kind,
	title: input.id,
	status: 'passed',
	exitCode: 0,
	durationMs: 1200,
	artifacts: input.artifacts,
	detail: input.detail ?? null,
});

const removeTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('benchmark suite reporting', () => {
	afterEach(removeTemporaryDirectories);

	it('renders project, step, gate, reference, and measurement sections', () => {
		const outputDir = temporaryDirectory();
		mkdirSync(join(outputDir, 'generated'), {recursive: true});
		mkdirSync(join(outputDir, 'references'), {recursive: true});
		writeFileSync(
			join(outputDir, 'generated', 'run.evaluation.json'),
			JSON.stringify({status: 'warning', summary: {pass: 1, warning: 2, failure: 3, skipped: 4}}),
		);
		writeFileSync(
			join(outputDir, 'generated', 'run.json'),
			JSON.stringify({
				workspace: {kind: 'generated', profile: null, fileCount: 2, symbolCount: 3, occurrenceCount: 4},
				scenarios: [{name: 'cold|edit', kind: 'cold', wallMs: 10, resources: {rssPeakBytes: 2048}, storage: {totalBytes: 1024 * 1024 * 1024}}],
				queries: {find_symbol: {p95Ms: null}},
			}),
		);
		writeFileSync(
			join(outputDir, 'references', 'report.json'),
			JSON.stringify({
				accuracy: {expected: 10, matched: 9, recall: 0.9, precision: 0.95},
				gate: {ok: false, failures: [{detail: 'missing reference'}]},
			}),
		);

		const summary = buildSuiteSummary({
			manifest: manifest({
				projects: [{name: 'project', directory: 'project', repository: 'https://example.com/project.git', revision: 'a'.repeat(40), lockfileSha256: null}],
				steps: [
					step({
						id: 'generated:run',
						kind: 'generated',
						artifacts: ['generated/run.json', 'generated/run.evaluation.json'],
						detail: 'bad | value\nsecond line',
					}),
					step({id: 'reference:typescript', kind: 'reference', artifacts: ['references/report.json']}),
					step({id: 'missing', kind: 'public', artifacts: ['missing.json', 'missing.evaluation.json']}),
				],
			}),
			outputDir,
		});

		expect(summary).toContain('| project |');
		expect(summary).toContain(String.raw`bad \| value second line`);
		expect(summary).toContain('| generated:run | warning | 1 | 2 | 3 | 4 |');
		expect(summary).toContain('Gate: **FAIL**');
		expect(summary).toContain('missing reference');
		expect(summary).toContain('| cold|edit | cold |');
		expect(summary).toContain('| find_symbol | - |');
	});

	it('renders empty gates, references, and reports', () => {
		const summary = buildSuiteSummary({
			manifest: manifest({status: 'failed', completedAt: null, identity: identity({dirty: true})}),
			outputDir: temporaryDirectory(),
		});

		expect(summary).toContain('Status: **FAILED**');
		expect(summary).toContain('Completed: -');
		expect(summary).toContain('(dirty)');
		expect(summary).toContain('No evaluation sidecars were produced.');
		expect(summary).toContain('Not run.');
		expect(summary).toContain('No reports were produced.');
	});

	it('reports unparseable reference and report artifacts', () => {
		const outputDir = temporaryDirectory();
		writeFileSync(join(outputDir, 'broken.json'), '{"invalid":true}');
		mkdirSync(join(outputDir, 'references'), {recursive: true});
		writeFileSync(join(outputDir, 'references', 'broken.json'), '{}');

		const summary = buildSuiteSummary({
			manifest: manifest({
				steps: [
					step({id: 'generated:broken', kind: 'generated', artifacts: ['broken.json']}),
					step({id: 'reference:broken', kind: 'reference', artifacts: ['references/broken.json']}),
				],
			}),
			outputDir,
		});

		expect(summary).toContain('The report could not be parsed.');
		expect(summary).toContain('No reports were produced.');
	});
});

describe('benchmark suite manifest', () => {
	afterEach(removeTemporaryDirectories);

	it('records identity and writes and reads a manifest', () => {
		const directory = temporaryDirectory();
		const cliPath = join(directory, 'cli.mjs');
		writeFileSync(cliPath, 'export {};');
		const recorded = identityOf({repositoryRoot: directory, cliPath});
		const outputDir = join(directory, 'output');
		mkdirSync(outputDir);
		const value = manifest({identity: recorded});

		writeManifest(outputDir, value);

		expect(readManifest(outputDir)).toStrictEqual(value);
		expect(recorded.dirty).toBe(false);
		expect(recorded.commit).toBe('unknown');
		expect(recorded.cliSha256).toBe(sha256File(cliPath));
	});

	it('compares identity fields and finds lockfiles', () => {
		const directory = temporaryDirectory();

		expect(sameIdentity(identity(), identity())).toBe(true);

		const differing: readonly Partial<SuiteIdentityType>[] = [
			{commit: 'different'},
			{statusSha256: 'different'},
			{cliSha256: 'different'},
			{platform: 'different'},
			{arch: 'different'},
			{cpuModel: 'different'},
		];

		for (const variant of differing) {
			expect(sameIdentity(identity(), identity(variant))).toBe(false);
		}

		expect(lockfileOf(directory)).toBeNull();
		writeFileSync(join(directory, 'yarn.lock'), '# yarn');
		expect(lockfileOf(directory)).toBe(join(directory, 'yarn.lock'));
	});

	it('rejects malformed manifests and missing artifacts', () => {
		const directory = temporaryDirectory();
		writeFileSync(join(directory, 'manifest.json'), JSON.stringify({schemaVersion: 2}));
		writeFileSync(join(directory, 'present.json'), '{}');

		expect(() => readManifest(directory)).toThrow(/Invalid suite manifest/u);
		expect(artifactsExist(directory, ['present.json'])).toBe(true);
		expect(artifactsExist(directory, ['present.json', 'absent.json'])).toBe(false);
	});

	it('verifies pinned public projects', () => {
		const directory = temporaryDirectory();
		const project = join(directory, 'project');
		mkdirSync(project, {recursive: true});
		expect(spawnSync('git', ['init'], {cwd: project, encoding: 'utf8'}).status).toBe(0);
		expect(
			spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'initial'], {
				cwd: project,
				encoding: 'utf8',
			}).status,
		).toBe(0);
		const revision = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: project, encoding: 'utf8'}).stdout.trim();
		writeFileSync(join(project, 'package-lock.json'), '{}');
		const entry = BenchmarkSuiteSchema.parse({
			schemaVersion: 1,
			id: 'public',
			publicProjects: [{name: 'project', repository: 'https://example.com/project.git', revision, directory: 'project', projectFile: 'tsconfig.json'}],
		}).publicProjects.find((candidate) => candidate.name === 'project');

		if (entry === undefined) {
			throw new Error('Expected a public project');
		}

		expect(verifyPublicProject({entry, projectsRoot: directory})).toStrictEqual({
			name: 'project',
			directory: 'project',
			repository: 'https://example.com/project.git',
			revision,
			lockfileSha256: sha256File(join(project, 'package-lock.json')),
		});
		expect(() => verifyPublicProject({entry: {...entry, directory: 'missing'}, projectsRoot: directory})).toThrow(/is not prepared/u);
		expect(() => verifyPublicProject({entry: {...entry, revision: 'f'.repeat(40)}, projectsRoot: directory})).toThrow(/expected/u);
	});
});

describe('benchmark suite command', () => {
	afterEach(removeTemporaryDirectories);

	it('forwards child output and writes a bounded log', async () => {
		const directory = temporaryDirectory();
		const lines: string[] = [];
		const result = await runCommand({
			command: process.execPath,
			args: ['-e', String.raw`process.stdout.write('out'); process.stderr.write('first\nsecond');`],
			cwd: directory,
			environment: {},
			logPath: join(directory, 'nested', 'run.log'),
			onLine: (line) => {
				lines.push(line);
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('out');
		expect(lines).toStrictEqual(['first', 'second']);
		expect(failureDetail('message | value')).toBe(String.raw`message \| value`);
	});

	it('cleans inherited CodeIndex overrides', () => {
		expect(cleanChildEnvironment({CODE_INDEX_ROOT: '/root', KEEP: 'yes'})).toStrictEqual({
			KEEP: 'yes',
			CODE_INDEX_ANALYTICS: 'false',
			NO_COLOR: '1',
		});
	});
});
