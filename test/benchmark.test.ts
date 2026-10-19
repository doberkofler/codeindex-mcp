import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {BENCHMARK_CORPUS_MARKER, benchmarkCorpusCounts, createBenchmarkCorpus, prepareBenchmarkWorkspace} from '../src/core/benchmark/corpus.ts';
import {runCursorScenario} from '../src/core/benchmark/cursorScenario.ts';
import {runEditScenario} from '../src/core/benchmark/editScenario.ts';
import {runBenchmarkReport} from '../src/core/benchmark/runBenchmark.ts';
import {type ConfigType, loadConfig} from '../src/core/config/config.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const tempDirectory = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));

const generatedConfig = (rootDir: string, databasePath: string): ConfigType =>
	loadConfig(
		{
			CODE_INDEX_ROOT: rootDir,
			CODE_INDEX_PROJECT_FILE: path.join(rootDir, 'tsconfig.json'),
			CODE_INDEX_DATABASE: databasePath,
			CODE_INDEX_ANALYTICS: 'false',
		},
		rootDir,
	);

describe('benchmark corpus', () => {
	it('generates a deterministic project for the same profile', () => {
		const first = tempDirectory('codeindex-benchmark-corpus-a-');
		const second = tempDirectory('codeindex-benchmark-corpus-b-');

		try {
			const left = createBenchmarkCorpus({directory: first, profile: 'small'});
			const right = createBenchmarkCorpus({directory: second, profile: 'small'});

			expect(left.generatedFileCount).toBe(right.generatedFileCount);
			expect(readFileSync(path.join(first, 'src', 'target.ts'), 'utf8')).toBe(readFileSync(path.join(second, 'src', 'target.ts'), 'utf8'));
			expect(readFileSync(path.join(first, 'tsconfig.json'), 'utf8')).toBe(readFileSync(path.join(second, 'tsconfig.json'), 'utf8'));
		} finally {
			rmSync(first, {recursive: true, force: true});
			rmSync(second, {recursive: true, force: true});
		}
	});

	it('marks generated corpora and refuses unrelated workspaces', () => {
		const corpusDirectory = tempDirectory('codeindex-benchmark-corpus-marker-');
		const unrelatedDirectory = tempDirectory('codeindex-benchmark-unrelated-');

		try {
			const corpus = createBenchmarkCorpus({directory: corpusDirectory, profile: 'small'});
			const markerPath = path.join(corpusDirectory, BENCHMARK_CORPUS_MARKER);
			const marker: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));

			expect(corpus.expected).toStrictEqual(benchmarkCorpusCounts('small'));
			expect(marker).toMatchObject({schemaVersion: 1, profile: 'small', ...corpus.expected});
			expect(prepareBenchmarkWorkspace({profile: 'small', workspace: corpusDirectory})).toStrictEqual({
				workspaceRoot: path.resolve(corpusDirectory),
				temporaryWorkspace: null,
			});
			expect(() => prepareBenchmarkWorkspace({profile: 'medium', workspace: corpusDirectory})).toThrow(/small benchmark corpus, not medium/u);

			writeFileSync(path.join(unrelatedDirectory, 'tsconfig.json'), '{}\n');
			expect(existsSync(path.join(unrelatedDirectory, BENCHMARK_CORPUS_MARKER))).toBe(false);
			expect(() => prepareBenchmarkWorkspace({profile: 'small', workspace: unrelatedDirectory})).toThrow(/generated benchmark corpus/u);
		} finally {
			rmSync(corpusDirectory, {recursive: true, force: true});
			rmSync(unrelatedDirectory, {recursive: true, force: true});
		}
	});
});

describe('benchmark report', () => {
	it('records build, storage, reuse, and query metrics', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 2, force: false, scenarios: ['warm_reuse']});
			const build = report.scenarios.find((scenario) => scenario.kind === 'build');

			expect(report.schemaVersion).toBe(2);
			expect(report.workspace.fileCount).toBeGreaterThan(0);
			expect(build).toBeDefined();
			expect(build?.storage.totalBytes).toBeGreaterThan(0);
			expect(build?.reuse.filesTotal).toBeGreaterThan(0);
			expect(build?.resources.rssPeakBytes).toBeGreaterThan(0);
			expect(Object.values(report.queries).some((query) => query.count === 2)).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('benchmark deep cursor', () => {
	it('captures production query plans', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const scenario = await runCursorScenario({config: fixture.config, maxDepth: 10, pageLimit: 2});

			expect(scenario.samples.length).toBeGreaterThan(0);
			expect(scenario.samples.some((sample) => sample.kind === 'outline')).toBe(true);
			expect(scenario.samples.every((sample) => sample.plan.length > 0)).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('benchmark edit-to-fresh', () => {
	it('measures the watcher path to a fresh generation', async () => {
		const root = tempDirectory('codeindex-benchmark-edit-');
		const databaseDirectory = tempDirectory('codeindex-benchmark-edit-db-');

		try {
			createBenchmarkCorpus({directory: root, profile: 'small'});
			const config = generatedConfig(root, path.join(databaseDirectory, 'index.sqlite'));
			const scenario = await runEditScenario({
				config,
				rounds: 1,
				timeoutMs: 30_000,
				targetPath: 'src/features/feature00001.ts',
			});

			expect(scenario.samples).toHaveLength(1);
			expect(scenario.samples[0]?.latencyMs).toBeGreaterThanOrEqual(0);
			expect(scenario.percentiles.p50Ms).not.toBeNull();
			expect(scenario.storage.totalBytes).toBeGreaterThan(0);
		} finally {
			rmSync(root, {recursive: true, force: true});
			rmSync(databaseDirectory, {recursive: true, force: true});
		}
	});
});
