import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseBenchmarkOptions} from '../src/core/benchmark/benchmarkOptions.ts';
import {phaseOf} from '../src/core/benchmark/benchmarkPhase.ts';
import {
	type BenchmarkPercentilesType,
	type BenchmarkReportType,
	type BenchmarkResourceType,
	type BenchmarkReuseType,
	type BenchmarkScenarioResultType,
	type BenchmarkStorageType,
} from '../src/core/benchmark/benchTypes.ts';
import {BENCHMARK_CORPUS_MARKER, benchmarkCorpusCounts, createBenchmarkCorpus, prepareBenchmarkWorkspace} from '../src/core/benchmark/corpus.ts';
import {runCursorScenario} from '../src/core/benchmark/cursorScenario.ts';
import {runEditScenario} from '../src/core/benchmark/editScenario.ts';
import {
	OraclePerformanceThresholdsSchema,
	aggregateOraclePerformance,
	collectOraclePerformanceSamples,
	evaluateOraclePerformance,
	loadOraclePerformanceThresholds,
	verifyOraclePerformanceRuns,
	type OraclePerformanceRunType,
	type OraclePerformanceThresholdsType,
} from '../src/core/benchmark/oraclePerformance.ts';
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

	it('names the failing scenario and SQLite result code', async () => {
		const failure = Object.assign(new Error('disk I/O error'), {errcode: 522, errstr: 'disk I/O error'});

		await expect(phaseOf('warm_reuse', Promise.reject(failure))).rejects.toThrow('warm_reuse failed: disk I/O error (sqlite errcode 522: disk I/O error)');
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
			const progress: number[] = [];
			const scenario = await runEditScenario({
				config,
				rounds: 1,
				timeoutMs: 30_000,
				targetPath: 'src/features/feature00001.ts',
				onProgress: (sample) => {
					progress.push(sample.iteration);
				},
			});

			expect(progress).toStrictEqual([1]);
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

const percentilesOf = (input: Readonly<{p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; count?: number}>): BenchmarkPercentilesType => ({
	count: input.count ?? 2,
	p50Ms: input.p50Ms,
	p95Ms: input.p95Ms,
	p99Ms: input.p99Ms,
	maxMs: input.maxMs,
});

const resourcesOf = (rssPeakBytes: number, cpuUserMs: number, cpuSystemMs: number): BenchmarkResourceType => ({
	cpuUserMs,
	cpuSystemMs,
	rssStartBytes: 1,
	rssPeakBytes,
	rssEndBytes: 1,
	lifetimeMaxRssBytes: rssPeakBytes,
});

const storageOf = (totalBytes: number, databaseBytes: number): BenchmarkStorageType => ({
	databaseBytes,
	walBytes: 0,
	shmBytes: 0,
	totalBytes,
	contentVersions: 1,
	extractionArtifacts: 1,
});

const reuseOf = (generationReused: boolean, filesReused: number): BenchmarkReuseType => ({
	generationReused,
	filesTotal: 2,
	filesReused,
	contentReuseRatio: filesReused / 2,
	artifactRowsBefore: 0,
	artifactRowsAfter: 0,
	artifactRowsRead: 0,
	artifactReuseRatio: 0,
	artifactConsumption: 'parse_digest',
});

const buildScenarioOf = (
	input: Readonly<{name: 'cold_build' | 'warm_reuse' | 'warm_rebuild'; wallMs: number; filesReused: number}>,
): Extract<BenchmarkScenarioResultType, {kind: 'build'}> => ({
	kind: 'build',
	name: input.name,
	wallMs: input.wallMs,
	generationId: 'generation',
	build: {reused: input.filesReused === 2 && input.name === 'warm_reuse', durationMs: input.wallMs - 100, stages: null},
	resources: resourcesOf(1000, 900, 100),
	storage: storageOf(2000, 1500),
	reuse: reuseOf(input.name === 'warm_reuse' && input.filesReused === 2, input.filesReused),
});

const editScenarioOf = (latencies: readonly number[]): Extract<BenchmarkScenarioResultType, {kind: 'edit'}> => ({
	kind: 'edit',
	name: 'edit_to_fresh',
	wallMs: 1000,
	rounds: latencies.length,
	debounceMs: 500,
	samples: latencies.map((latencyMs, index) => ({iteration: index + 1, latencyMs, generationId: `generation-${String(index)}`})),
	percentiles: {
		count: latencies.length,
		p50Ms: [...latencies].sort((left, right) => left - right)[Math.floor(latencies.length / 2)] ?? 0,
		p95Ms: Math.max(...latencies),
		p99Ms: Math.max(...latencies),
		maxMs: Math.max(...latencies),
	},
	build: null,
	resources: resourcesOf(1000, 900, 100),
	storage: storageOf(2000, 1500),
	reuse: reuseOf(false, 2),
});

const cursorScenarioOf = (wallMs: number, usesIndex = true, usesTempBTree = false): Extract<BenchmarkScenarioResultType, {kind: 'cursor'}> => ({
	kind: 'cursor',
	name: 'deep_cursor',
	wallMs,
	maxDepth: 10,
	pageLimit: 2,
	samples: [{kind: 'outline', depth: 0, limit: 2, elapsedMs: 1, items: 1, bytes: 1, plan: ['SEARCH symbol USING INDEX'], usesIndex, usesTempBTree}],
	resources: resourcesOf(1000, 900, 100),
	storage: storageOf(2000, 1500),
});

const queriesOf = (p95Ms: number): Readonly<Record<string, BenchmarkPercentilesType>> => ({
	status: percentilesOf({p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0}),
	find_symbol: percentilesOf({p50Ms: p95Ms, p95Ms, p99Ms: p95Ms, maxMs: p95Ms}),
	outline: percentilesOf({p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0}),
	find_references: percentilesOf({p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0}),
	read_symbol: percentilesOf({p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0}),
});

const reportOf = (
	input: Readonly<{
		generatedAt: string;
		scenarios: readonly BenchmarkScenarioResultType[];
		queries: Readonly<Record<string, BenchmarkPercentilesType>>;
		sourceHash?: string;
		configHash?: string;
	}>,
): BenchmarkReportType => ({
	schemaVersion: 2,
	generatedAt: input.generatedAt,
	machine: {nodeVersion: 'v26.10.0', platform: 'darwin', arch: 'arm64', cpuModel: 'test', totalMemoryBytes: 1},
	runtime: {workerEntry: true, scenariosInProcess: true},
	workspace: {
		kind: 'external',
		profile: null,
		projectId: 'oracle-production',
		projectName: 'workspace',
		fileCount: 2,
		symbolCount: 2,
		occurrenceCount: 2,
		dependencyEdgeCount: 0,
		sourceHash: input.sourceHash ?? 'a'.repeat(64),
		configHash: input.configHash ?? 'b'.repeat(64),
	},
	iterations: 2,
	freshness: {state: 'current', checkedAt: '2026-10-25T00:00:00.000Z', dirtyFileCount: 0},
	scenarios: input.scenarios,
	queries: input.queries,
});

const runOf = (
	input: Readonly<{sourceHash: string; warmReused: boolean; coldWallMs: number; queryP95Ms: number; usesTempBTree?: boolean; configHash?: string}>,
): OraclePerformanceRunType => ({
	cold: reportOf({
		generatedAt: 'cold',
		sourceHash: input.sourceHash,
		...(input.configHash === undefined ? {} : {configHash: input.configHash}),
		scenarios: [buildScenarioOf({name: 'cold_build', wallMs: input.coldWallMs, filesReused: 0})],
		queries: queriesOf(input.queryP95Ms),
	}),
	warm: reportOf({
		generatedAt: 'warm',
		sourceHash: input.sourceHash,
		scenarios: [buildScenarioOf({name: 'warm_reuse', wallMs: 10, filesReused: input.warmReused ? 2 : 0})],
		queries: queriesOf(input.queryP95Ms),
	}),
	rebuild: reportOf({
		generatedAt: 'rebuild',
		sourceHash: input.sourceHash,
		scenarios: [buildScenarioOf({name: 'warm_rebuild', wallMs: input.coldWallMs, filesReused: 2})],
		queries: queriesOf(input.queryP95Ms),
	}),
	edit: reportOf({generatedAt: 'edit', sourceHash: input.sourceHash, scenarios: [editScenarioOf([100, 200])], queries: queriesOf(input.queryP95Ms)}),
	deep: reportOf({
		generatedAt: 'deep',
		sourceHash: input.sourceHash,
		scenarios: [cursorScenarioOf(5, true, input.usesTempBTree ?? false)],
		queries: queriesOf(input.queryP95Ms),
	}),
});

const thresholdsOf = (): OraclePerformanceThresholdsType => ({
	schemaVersion: 1 as const,
	declaredAt: '2026-10-25T00:00:00.000Z',
	corpus: {bundle: 'benchmark/oracle-production-20261027/corpus.json', sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), fileCount: 2},
	metrics: {
		'cold.wallMs': {statistic: 'median' as const, warn: 1000, fail: 2000, unit: 'ms' as const},
		'old.wallMs': {statistic: 'median' as const, warn: 1000, fail: 2000, unit: 'ms' as const},
	},
	variance: {'cold.wallMs': {warnCvPercent: 10, failCvPercent: 20}},
});

describe('Oracle performance evidence', () => {
	it('aggregates median, tail, and variance samples', () => {
		const aggregate = aggregateOraclePerformance([10, 20, 30, 40, 50]);

		expect(aggregate.count).toBe(5);
		expect(aggregate.median).toBe(30);
		expect(aggregate.p95).toBe(50);
		expect(aggregate.max).toBe(50);
		expect(aggregate.cvPercent).toBeCloseTo(47.14, 2);
		expect(() => aggregateOraclePerformance([])).toThrow(/empty/u);
	});

	it('flattens runs and evaluates declared absolute and variance gates', () => {
		const runs = [
			runOf({sourceHash: 'a'.repeat(64), warmReused: true, coldWallMs: 100, queryP95Ms: 1}),
			runOf({sourceHash: 'a'.repeat(64), warmReused: true, coldWallMs: 300, queryP95Ms: 3}),
		];
		const samples = collectOraclePerformanceSamples({
			runs,
			bundles: {mcp: {rawBytes: 10, gzipBytes: 5}, cli: {rawBytes: 20, gzipBytes: 8}},
		});
		const aggregates = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, aggregateOraclePerformance(values)]));

		expect(samples['cold.wallMs']).toStrictEqual([100, 300]);
		expect(samples['edit.latencyMs']).toStrictEqual([100, 200, 100, 200]);
		expect(samples['queries.find_symbol.p95Ms']).toStrictEqual([1, 3]);

		const evaluation = evaluateOraclePerformance({
			aggregates,
			thresholds: thresholdsOf(),
			integrity: verifyOraclePerformanceRuns({runs, expected: {sourceHash: 'a'.repeat(64), fileCount: 2, editRounds: 2}}),
		});

		expect(evaluation.status).toBe('failure');
		expect(evaluation.gates.find((gate) => gate.code === 'metric.old.wallMs')?.status).toBe('failure');
		expect(evaluation.gates.find((gate) => gate.code === 'metric.cold.wallMs')?.status).toBe('pass');
		expect(evaluation.gates.find((gate) => gate.code === 'integrity.cold.sourceHash')?.status).toBe('pass');
	});

	it('reports identity, reuse, and cursor integrity failures', () => {
		const runs = [runOf({sourceHash: 'c'.repeat(64), warmReused: false, coldWallMs: 100, queryP95Ms: 1, usesTempBTree: true})];
		const gates = verifyOraclePerformanceRuns({runs, expected: {sourceHash: 'a'.repeat(64), fileCount: 2, editRounds: 2}});

		expect(gates.find((gate) => gate.code === 'integrity.cold.sourceHash')?.status).toBe('failure');
		expect(gates.find((gate) => gate.code === 'integrity.warm.reuse')?.status).toBe('failure');
		expect(gates.find((gate) => gate.code === 'integrity.deep_cursor.temp_btree')?.status).toBe('warning');

		const unstable = [
			runOf({sourceHash: 'a'.repeat(64), warmReused: true, coldWallMs: 100, queryP95Ms: 1, configHash: 'b'.repeat(64)}),
			runOf({sourceHash: 'a'.repeat(64), warmReused: true, coldWallMs: 100, queryP95Ms: 1, configHash: 'd'.repeat(64)}),
		];
		const unstableGates = verifyOraclePerformanceRuns({runs: unstable, expected: {sourceHash: 'a'.repeat(64), fileCount: 2, editRounds: 2}});

		expect(unstableGates.find((gate) => gate.code === 'integrity.cold.configHash')?.status).toBe('failure');
	});

	it('loads the committed thresholds and rejects inverted bounds', () => {
		const thresholds = loadOraclePerformanceThresholds(path.resolve(import.meta.dirname, '..', 'benchmark', 'oracle-performance', 'thresholds.json'));
		const directory = tempDirectory('codeindex-oracle-thresholds-');

		try {
			expect(thresholds.metrics['cold.wallMs']?.fail).toBe(30_000);
			expect(thresholds.variance['rebuild.wallMs']?.warnCvPercent).toBe(20);
			expect(OraclePerformanceThresholdsSchema.safeParse(thresholdsOf()).success).toBe(true);

			const invalidPath = path.join(directory, 'thresholds.json');
			writeFileSync(
				invalidPath,
				`${JSON.stringify({...thresholdsOf(), metrics: {'cold.wallMs': {statistic: 'median', warn: 2, fail: 1, unit: 'ms'}}})}\n`,
				'utf8',
			);
			expect(() => loadOraclePerformanceThresholds(invalidPath)).toThrow(/warn must be lower than fail/u);
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});

describe('benchmark disposable options', () => {
	const options = {
		iterations: '1',
		editRounds: '1',
		maxDepth: '1',
		pageLimit: '1',
		rebuild: false,
		keepWorkspace: false,
		disposable: false,
	};

	it('refuses external edit-to-fresh without an explicit disposable copy and target', () => {
		expect(() => parseBenchmarkOptions({...options, root: '/tmp/workspace', scenarios: 'edit'})).toThrow(/requires --edit-target/u);
		expect(() => parseBenchmarkOptions({...options, root: '/tmp/workspace', scenarios: 'edit', editTarget: 'src/a.pkb'})).toThrow(/pass --disposable/u);
		expect(parseBenchmarkOptions({...options, root: '/tmp/workspace', scenarios: 'edit', editTarget: 'src/a.pkb', disposable: true})).toMatchObject({
			editTarget: 'src/a.pkb',
		});
	});

	it('rejects absolute and escaping edit targets', () => {
		for (const editTarget of ['/tmp/a.pkb', '../a.pkb', 'src/../../a.pkb']) {
			expect(() => parseBenchmarkOptions({...options, root: '/tmp/workspace', scenarios: 'edit', editTarget, disposable: true})).toThrow(/workspace-relative/u);
		}
	});

	it('allows an explicit database for a disposable root', () => {
		expect(() => parseBenchmarkOptions({...options, scenarios: 'cold', database: '/tmp/index.sqlite'})).toThrow(/omit --database or pass --disposable/u);
		expect(parseBenchmarkOptions({...options, scenarios: 'cold', database: '/tmp/index.sqlite', disposable: true}).scenarios).toStrictEqual(['cold_build']);
	});
});
