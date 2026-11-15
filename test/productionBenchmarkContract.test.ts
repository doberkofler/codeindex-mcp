import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
	PRODUCTION_SCENARIOS,
	ProductionBenchmarkManifestSchema,
	productionManifestDigest,
	productionSemanticDigest,
	type ProductionBenchmarkManifestType,
	type ProductionBenchmarkReportType,
} from '../src/core/benchmark/productionContract.ts';
import {compareProductionBenchmarkReports, createProductionBenchmarkReport} from '../src/core/benchmark/productionComparison.ts';
import {runProductionBenchmarkComparison} from '../src/core/benchmark/productionCommand.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const manifestOf = (): ProductionBenchmarkManifestType =>
	ProductionBenchmarkManifestSchema.parse({
		schemaVersion: 1,
		id: 'production-refresh-v1',
		declaredAt: '2026-11-01T00:00:00.000Z',
		evidenceExpiresAt: '2026-12-01T00:00:00.000Z',
		engines: {
			control: {entry: '../control/cli.mjs', revision: '1111111', bundleSha256: HASH_A},
			candidate: {entry: '../candidate/cli.mjs', revision: '2222222', bundleSha256: HASH_B},
		},
		runtime: {nodeVersion: 'v26.6.0', platform: 'darwin', arch: 'arm64'},
		execution: {
			workspace: 'disposable_copy',
			database: 'temporary_sqlite',
			scenarioTimeoutMs: 120_000,
			pollIntervalMs: 10,
			rssSampleIntervalMs: 25,
			processTreeSampleIntervalMs: 250,
		},
		corpus: {
			snapshot: '../private/production-snapshot',
			configuration: '../private/codeindex.config.json',
			sha256: HASH_C,
			configurationSha256: HASH_D,
		},
		thresholds: {path: '../private/thresholds.json', sha256: HASH_A},
		warmups: 1,
		repetitions: 2,
		scenarioOrder: PRODUCTION_SCENARIOS,
		scenarios: {
			typescriptEdit: {adapterId: 'typescript', target: 'typescript/src/index.ts', mutationSha256: HASH_A},
			oracleEdit: {adapterId: 'oracle', target: 'oracle/pkg.pkb', mutationSha256: HASH_B},
			burstSupersession: {edits: 3, intervalMs: 10},
			twoProcessContention: {processes: 2, startSkewMs: 0},
			workerIdleMemory: {durationMs: 1000, sampleIntervalMs: 100},
			processRestart: {shutdownTimeoutMs: 5000, restartDelayMs: 100},
		},
	});

const runOf = (
	scenario: (typeof PRODUCTION_SCENARIOS)[number],
	repetition: number,
	overrides: Partial<ProductionBenchmarkReportType['runs'][number]> = {},
): ProductionBenchmarkReportType['runs'][number] => ({
	scenario,
	repetition,
	ownerDurationMs: 100,
	observerWaitMs: scenario === 'two_process_contention' ? 50 : 0,
	eventToPublicationMs: 100,
	stages: {
		probeMs: 1,
		scanMs: 2,
		compilerMs: 3,
		extractionMs: 4,
		finalizationMs: 5,
		insertionMs: 6,
		verificationMs: 7,
		publicationMs: 8,
		checkpointMs: 9,
		maintenanceMs: 10,
	},
	resources: {
		processRssStartBytes: 100,
		processRssPeakBytes: 200,
		processRssEndBytes: 150,
		processTreeRssStartBytes: 200,
		processTreeRssPeakBytes: 400,
		processTreeRssEndBytes: 300,
		processTreeRssIdleBytes: 250,
		stageBoundaries: [
			{stage: 'start', processRssBytes: 100, processTreeRssBytes: 200},
			{stage: 'complete', processRssBytes: 150, processTreeRssBytes: 300},
		],
	},
	storage: {databaseBytes: 1000, walBytes: 100, shmBytes: 10},
	facts: {digested: 10, selected: 9, deleted: 1, written: 8, validated: 8},
	adapters: [
		{adapterId: 'typescript', probes: 1, scans: 1, extractions: 1, factWrites: 5},
		{adapterId: 'oracle', probes: 1, scans: 1, extractions: 1, factWrites: 3},
	],
	supersession: {started: 1, published: 1, discarded: 0, discardedDurationMs: 0},
	digests: {factsSha256: HASH_C, queryResultsSha256: HASH_D},
	...overrides,
});

const reportOf = (manifest: ProductionBenchmarkManifestType, role: 'control' | 'candidate'): ProductionBenchmarkReportType =>
	createProductionBenchmarkReport({
		manifest,
		role,
		startedAt: '2026-11-02T00:00:00.000Z',
		completedAt: '2026-11-02T01:00:00.000Z',
		runs: Array.from({length: manifest.repetitions}, (_value, index) => index + 1).flatMap((repetition) =>
			manifest.scenarioOrder.map((scenario) => runOf(scenario, repetition)),
		),
	});

describe('production benchmark contract', () => {
	it('accepts the frozen eight-scenario manifest and hashes it canonically', () => {
		const manifest = manifestOf();
		const reordered = {
			...manifest,
			engines: {candidate: manifest.engines.candidate, control: manifest.engines.control},
		};

		expect(manifest.scenarioOrder).toStrictEqual(PRODUCTION_SCENARIOS);
		expect(productionManifestDigest(manifest)).toBe(productionManifestDigest(ProductionBenchmarkManifestSchema.parse(reordered)));
		expect(productionSemanticDigest({symbols: [{name: 'private'}], count: 1})).toBe(productionSemanticDigest({count: 1, symbols: [{name: 'private'}]}));
	});

	it('rejects missing scenarios and unknown report fields', () => {
		const manifest = manifestOf();
		const report = reportOf(manifest, 'control');
		const incompleteRun = {...report.runs[0]} as unknown as Record<string, unknown>;
		delete incompleteRun['stages'];

		expect(() => ProductionBenchmarkManifestSchema.parse({...manifest, scenarioOrder: PRODUCTION_SCENARIOS.slice(0, -1)})).toThrow('Too small');
		expect(() => compareProductionBenchmarkReports(manifest, {...report, sourceText: 'secret'}, reportOf(manifest, 'candidate'))).toThrow('Unrecognized key');
		expect(() =>
			compareProductionBenchmarkReports(manifest, {...report, runs: [incompleteRun, ...report.runs.slice(1)]}, reportOf(manifest, 'candidate')),
		).toThrow('stages');
	});

	it('compares complete control and candidate evidence', () => {
		const manifest = manifestOf();
		const comparison = compareProductionBenchmarkReports(manifest, reportOf(manifest, 'control'), reportOf(manifest, 'candidate'));

		expect(comparison.status).toBe('pass');
		expect(comparison.semanticMismatches).toBe(0);
		expect(comparison.scenarios).toHaveLength(8);
		expect(comparison.scenarios.every((scenario) => scenario.samples === 2)).toBe(true);
	});

	it('fails semantic drift while retaining performance deltas', () => {
		const manifest = manifestOf();
		const candidate = reportOf(manifest, 'candidate');
		const runs = candidate.runs.map((run, index) =>
			index === 0
				? {
						...run,
						ownerDurationMs: 80,
						digests: {...run.digests, factsSha256: HASH_A},
					}
				: run,
		);
		const comparison = compareProductionBenchmarkReports(manifest, reportOf(manifest, 'control'), {...candidate, runs});

		expect(comparison.status).toBe('failure');
		expect(comparison.semanticMismatches).toBe(1);
		expect(comparison.scenarios[0]?.ownerDurationDeltaPercent).toBe(-10);
	});

	it('fails closed on identity drift, incomplete runs, and stale evidence', () => {
		const manifest = manifestOf();
		const control = reportOf(manifest, 'control');
		const candidate = reportOf(manifest, 'candidate');

		expect(() => compareProductionBenchmarkReports(manifest, {...control, corpus: {...control.corpus, sha256: HASH_A}}, candidate)).toThrow('identity drifted');
		expect(() => compareProductionBenchmarkReports(manifest, {...control, runs: control.runs.slice(1)}, candidate)).toThrow(
			'missing, duplicate, or out-of-order',
		);
		expect(() => compareProductionBenchmarkReports(manifest, {...control, completedAt: '2026-12-02T00:00:00.000Z'}, candidate)).toThrow('stale');
	});

	it('loads retained evidence and writes a bounded comparison', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'codeindex-production-benchmark-'));
		const manifest = manifestOf();
		const stdout: string[] = [];

		try {
			writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest), {encoding: 'utf8'});
			writeFileSync(path.join(directory, 'control.json'), JSON.stringify(reportOf(manifest, 'control')), {encoding: 'utf8'});
			writeFileSync(path.join(directory, 'candidate.json'), JSON.stringify(reportOf(manifest, 'candidate')), {encoding: 'utf8'});

			const comparison = runProductionBenchmarkComparison({
				values: {
					manifest: 'manifest.json',
					control: 'control.json',
					candidate: 'candidate.json',
					output: 'comparison.json',
				},
				cwd: directory,
				io: {
					stdout: (line) => {
						stdout.push(line);
					},
					stderr: () => {
						throw new Error('unexpected stderr');
					},
				},
			});

			expect(comparison.status).toBe('pass');
			expect(JSON.parse(readFileSync(path.join(directory, 'comparison.json'), 'utf8'))).toMatchObject({
				status: 'pass',
				semanticMismatches: 0,
			});
			expect(stdout.join('\n')).toContain('Production benchmark comparison: pass');
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});
