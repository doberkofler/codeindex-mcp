import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {runMultiAdapterBenchmark} from '../src/core/benchmark/multiAdapterCommand.ts';
import {loadMultiAdapterBaseline, evaluateMultiAdapterReport} from '../src/core/benchmark/multiAdapterEvaluate.ts';
import {loadMultiAdapterCorpus, multiAdapterCorpusDigest, prepareMultiAdapterWorkspace} from '../src/core/benchmark/multiAdapterCorpus.ts';
import {runMultiAdapterScenario} from '../src/core/benchmark/multiAdapterScenario.ts';
import {type AdapterCountersType, type MultiAdapterReportType} from '../src/core/benchmark/multiAdapterTypes.ts';

const corpusPath = path.resolve(import.meta.dirname, '..', 'benchmark', 'multi-adapter-corpus');
const baselinePath = path.resolve(import.meta.dirname, '..', 'benchmark', 'baseline-multi-adapter.json');

const counter = (overrides: Partial<AdapterCountersType> = {}): AdapterCountersType => ({probes: 0, scans: 0, extractions: 0, factWrites: 0, ...overrides});

const validReport = (): MultiAdapterReportType => {
	const corpus = loadMultiAdapterCorpus(corpusPath);
	const samples = Array.from({length: 10}, (_value, index) => ({
		iteration: index + 1,
		adapterId: index % 2 === 0 ? ('typescript' as const) : ('oracle' as const),
		path: index % 2 === 0 ? 'typescript/platform/src/index.ts' : 'oracle/database/hr_api.pkb',
		latencyMs: 1000,
		eventToPublicationMs: 1000,
		revision: index + 2,
	}));
	const rounds = samples.map((sample) => ({
		iteration: sample.iteration,
		sourceAdapterId: sample.adapterId,
		typescript: sample.adapterId === 'typescript' ? counter({probes: 1, scans: 1, extractions: 1, factWrites: 10}) : counter(),
		oracle: sample.adapterId === 'oracle' ? counter({probes: 1, scans: 1, extractions: 1, factWrites: 10}) : counter(),
	}));

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		machine: {nodeVersion: 'v26.0.0', platform: 'darwin', arch: 'arm64', cpuModel: 'test', totalMemoryBytes: 1024},
		corpus: {
			id: corpus.metadata.id,
			sha256: corpus.sha256,
			typescriptProjectContexts: 5,
			oracleProjectContexts: 1,
			fileCount: 65,
			symbolCount: 500,
			editTargets: corpus.metadata.editTargets,
		},
		edit: {
			rounds: 10,
			debounceMs: 100,
			samples,
			percentiles: {count: 10, p50Ms: 1000, p95Ms: 1000, p99Ms: 1000, maxMs: 1000},
		},
		isolation: {
			typescriptEdits: {typescript: counter({probes: 5, scans: 5, extractions: 5, factWrites: 50}), oracle: counter()},
			oracleEdits: {typescript: counter(), oracle: counter({probes: 5, scans: 5, extractions: 5, factWrites: 50})},
			rounds,
		},
		supersession: {
			startedAttempts: 12,
			attempts: 0,
			discarded: [],
			discardedDurationMs: 0,
			finalPublishedDurationMs: 900,
		},
		resources: {processTreeRssPeakBytes: 512 * 1024 * 1024, processTreeRssIdleBytes: 256 * 1024 * 1024, rssPeakBytes: 256 * 1024 * 1024},
		storage: {databaseBytes: 1024, walBytes: 0, shmBytes: 0},
		freshness: {state: 'current', dirtyFileCount: 0},
	};
};

describe('multi-adapter benchmark corpus', () => {
	it('declares five TypeScript contexts and one Oracle context', () => {
		const corpus = loadMultiAdapterCorpus(corpusPath);

		expect(corpus.metadata.typescriptProjectContexts).toBeGreaterThanOrEqual(5);
		expect(corpus.metadata.oracleProjectContexts).toBeGreaterThanOrEqual(1);
		expect(corpus.metadata.editTargets.map((target) => target.adapterId)).toStrictEqual(['typescript', 'oracle']);
		expect(multiAdapterCorpusDigest(corpusPath)).toBe(corpus.sha256);
	});

	it('measures one edit per adapter without cross-adapter work', async () => {
		const corpus = loadMultiAdapterCorpus(corpusPath);
		const workspace = prepareMultiAdapterWorkspace({corpus, keep: false});

		try {
			const report = await runMultiAdapterScenario({workspace, rounds: 2, churn: false, timeoutMs: 30_000});
			const typescript = report.edit.samples.find((sample) => sample.adapterId === 'typescript');
			const oracle = report.edit.samples.find((sample) => sample.adapterId === 'oracle');
			const typescriptRound = report.isolation.rounds.find((round) => round.sourceAdapterId === 'typescript');
			const oracleRound = report.isolation.rounds.find((round) => round.sourceAdapterId === 'oracle');

			expect(typescript?.eventToPublicationMs).toBeGreaterThan(0);
			expect(oracle?.eventToPublicationMs).toBeGreaterThan(0);
			expect(typescriptRound?.oracle).toStrictEqual(counter());
			expect(oracleRound?.typescript).toStrictEqual(counter());
			expect(typescriptRound?.typescript.scans).toBe(1);
			expect(oracleRound?.oracle.scans).toBe(1);
		} finally {
			workspace.cleanup();
		}
	});
});

describe('multi-adapter benchmark command', () => {
	it('writes report, evaluation, and summary artifacts', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'codeindex-multi-command-'));
		const baseline = loadMultiAdapterBaseline(baselinePath);
		const shortBaselinePath = path.join(directory, 'baseline.json');
		const outputPath = path.join(directory, 'report.json');
		const summaryPath = path.join(directory, 'summary.md');
		const stdout: string[] = [];
		const stderr: string[] = [];

		writeFileSync(shortBaselinePath, JSON.stringify({...baseline, thresholds: {...baseline.thresholds, minimumEditSamples: 2}}), {encoding: 'utf8'});

		try {
			const code = await runMultiAdapterBenchmark({
				values: {
					baseline: shortBaselinePath,
					output: outputPath,
					summary: summaryPath,
					rounds: '2',
					keepWorkspace: false,
					churn: false,
				},
				io: {
					stdout: (line) => {
						stdout.push(line);
					},
					stderr: (line) => {
						stderr.push(line);
					},
				},
				cwd: path.resolve(import.meta.dirname, '..'),
			});

			expect(code).toBe(0);
			expect(stderr).toStrictEqual([]);
			expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({schemaVersion: 1, edit: {rounds: 2}});
			expect(readFileSync(summaryPath, 'utf8')).toContain('# Multi-adapter edit-to-fresh benchmark');
			expect(stdout.join('\n')).toContain('Evaluation: pass');
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});

describe('multi-adapter benchmark gates', () => {
	it('passes a complete report with isolated edits and bounded resources', () => {
		const baseline = loadMultiAdapterBaseline(baselinePath);
		const evaluation = evaluateMultiAdapterReport(validReport(), baseline);

		expect(evaluation.status).toBe('pass');
		expect(evaluation.gates.find((entry) => entry.code === 'absolute.edit.p95')?.status).toBe('pass');
		expect(evaluation.gates.find((entry) => entry.code === 'isolation.cross_adapter')?.status).toBe('pass');
	});

	it('fails closed when a required metric is missing', () => {
		const baseline = loadMultiAdapterBaseline(baselinePath);
		const report = validReport() as unknown as Record<string, unknown>;
		const resources = report['resources'] as Record<string, unknown>;
		delete resources['processTreeRssIdleBytes'];

		const evaluation = evaluateMultiAdapterReport(report, baseline);

		expect(evaluation.status).toBe('failure');
		expect(evaluation.gates.map((entry) => entry.code)).toStrictEqual(['compatibility.report']);
		expect(evaluation.gates[0]?.message).toContain('missing a required metric');
	});

	it('fails when the edit p95 exceeds the ceiling', () => {
		const baseline = loadMultiAdapterBaseline(baselinePath);
		const report = validReport();
		const evaluation = evaluateMultiAdapterReport(
			{
				...report,
				edit: {
					...report.edit,
					samples: report.edit.samples.map((sample) => ({...sample, eventToPublicationMs: 20_000})),
					percentiles: {...report.edit.percentiles, p95Ms: 20_000},
				},
			},
			baseline,
		);

		expect(evaluation.status).toBe('failure');
		expect(evaluation.gates.find((entry) => entry.code === 'absolute.edit.p95')?.status).toBe('failure');
	});

	it('fails when a targeted edit touches the other adapter', () => {
		const baseline = loadMultiAdapterBaseline(baselinePath);
		const report = validReport();
		const rounds = report.isolation.rounds.map((round, index) =>
			index === 0 ? {...round, oracle: counter({probes: 1, scans: 1, extractions: 1, factWrites: 2})} : round,
		);
		const evaluation = evaluateMultiAdapterReport(
			{
				...report,
				isolation: {...report.isolation, rounds},
			},
			baseline,
		);

		expect(evaluation.status).toBe('failure');
		expect(evaluation.gates.find((entry) => entry.code === 'isolation.cross_adapter')?.status).toBe('failure');
	});

	it('fails when superseded attempts exceed the bound', () => {
		const baseline = loadMultiAdapterBaseline(baselinePath);
		const report = validReport();
		const discarded = Array.from({length: 6}, (_value, index) => ({
			attempt: index + 1,
			cause: 'adapter-change' as const,
			stage: 'extraction' as const,
			adapterId: 'typescript',
			durationMs: 100,
		}));
		const evaluation = evaluateMultiAdapterReport(
			{
				...report,
				supersession: {...report.supersession, attempts: 6, discarded, discardedDurationMs: 600},
			},
			baseline,
		);

		expect(evaluation.status).toBe('failure');
		expect(evaluation.gates.find((entry) => entry.unit === 'count' && entry.code === 'absolute.superseded.attempts')?.status).toBe('failure');
	});

	it('fails when peak process-tree RSS exceeds the ceiling', () => {
		const baseline = loadMultiAdapterBaseline(baselinePath);
		const report = validReport();
		const evaluation = evaluateMultiAdapterReport(
			{
				...report,
				resources: {...report.resources, processTreeRssPeakBytes: 4 * 1024 * 1024 * 1024},
			},
			baseline,
		);

		expect(evaluation.status).toBe('failure');
		expect(evaluation.gates.find((entry) => entry.code === 'absolute.process_tree.rss_peak')?.status).toBe('failure');
	});
});
