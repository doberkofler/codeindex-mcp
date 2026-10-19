import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
	BenchmarkBaselineSchema,
	BenchmarkReferenceSchema,
	loadBenchmarkBaseline,
	type BenchmarkBaselineType,
	type BenchmarkReferenceType,
} from '../src/core/benchmark/baseline.ts';
import {type BenchmarkReportType} from '../src/core/benchmark/benchTypes.ts';
import {benchmarkCorpusCounts} from '../src/core/benchmark/corpus.ts';
import {runBenchmarkCommand, runBenchmarkReport} from '../src/core/benchmark/runBenchmark.ts';
import {evaluateBenchmark} from '../src/core/benchmark/evaluate.ts';
import {buildBenchmarkSummary} from '../src/core/benchmark/summary.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const tempDirectory = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));

const writeJson = (filePath: string, value: unknown): void => {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const baselineOf = (overrides: Readonly<Record<string, unknown>> = {}): BenchmarkBaselineType =>
	BenchmarkBaselineSchema.parse({
		schemaVersion: 1,
		reportSchemaVersion: 2,
		compatibility: {workspaceKind: 'external', profile: null, fileCountToleranceRatio: 0.05, symbolCountToleranceRatio: 0.05},
		requiredScenarios: ['cold_build', 'deep_cursor'],
		thresholds: {},
		...overrides,
	});

const brokenPlan = (report: BenchmarkReportType): BenchmarkReportType => ({
	...report,
	scenarios: report.scenarios.map((scenario) =>
		scenario.kind === 'cursor'
			? {
					...scenario,
					samples: scenario.samples.map((sample, index) => (index === 0 ? {...sample, usesIndex: false} : sample)),
				}
			: scenario,
	),
});

const referenceOf = (report: BenchmarkReportType): BenchmarkReferenceType =>
	BenchmarkReferenceSchema.parse({
		reportSchemaVersion: report.schemaVersion,
		machine: report.machine,
		workspace: {
			kind: report.workspace.kind,
			profile: report.workspace.profile,
			fileCount: report.workspace.fileCount,
			symbolCount: report.workspace.symbolCount,
		},
		scenarios: report.scenarios.map((scenario) => ({
			kind: scenario.kind,
			name: scenario.name,
			wallMs: Math.max(1, scenario.wallMs / 10),
			resources: {
				cpuUserMs: scenario.resources.cpuUserMs,
				cpuSystemMs: scenario.resources.cpuSystemMs,
				rssPeakBytes: scenario.resources.rssPeakBytes,
			},
			storage: {totalBytes: scenario.storage.totalBytes},
			...(scenario.kind === 'edit' ? {percentiles: scenario.percentiles} : {}),
			...(scenario.kind === 'cursor' ? {samples: scenario.samples.map((sample) => ({elapsedMs: sample.elapsedMs}))} : {}),
		})),
		queries: Object.fromEntries(Object.entries(report.queries).map(([name, percentile]) => [name, {p95Ms: percentile.p95Ms}])),
	});

describe('benchmark baseline', () => {
	it('loads a versioned baseline and rejects an incompatible version', () => {
		const directory = tempDirectory('codeindex-benchmark-baseline-');
		const baselinePath = path.join(directory, 'baseline.json');

		try {
			writeJson(baselinePath, {
				schemaVersion: 1,
				reportSchemaVersion: 2,
				compatibility: {workspaceKind: 'generated', profile: 'small'},
				thresholds: {},
			});
			const baseline = loadBenchmarkBaseline(baselinePath);

			expect(baseline.schemaVersion).toBe(1);
			expect(baseline.thresholds.buildFailureRatio).toBe(5);
			expect(baseline.requiredScenarios).toContain('edit_to_fresh');

			writeJson(baselinePath, {schemaVersion: 2});
			expect(() => loadBenchmarkBaseline(baselinePath)).toThrow(/Invalid benchmark baseline/u);
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});

describe('benchmark evaluation', () => {
	it('separates pass, warning, and failure gates and reports invalid plans', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 1, force: false, scenarios: ['deep_cursor']});
			const baseline = baselineOf();
			const evaluation = evaluateBenchmark(report, baseline);
			const broken = evaluateBenchmark(brokenPlan(report), baseline);

			expect(evaluation.summary.pass + evaluation.summary.warning + evaluation.summary.failure + evaluation.summary.skipped).toBe(evaluation.gates.length);
			expect(evaluation.status).not.toBe('failure');
			expect(evaluation.gates.find((entry) => entry.code === 'plan.index_usage')?.status).toBe('pass');
			expect(broken.status).toBe('failure');
			expect(broken.gates.find((entry) => entry.code === 'plan.index_usage')?.status).toBe('failure');
		} finally {
			fixture.cleanup();
		}
	});

	it('fails workspace compatibility mismatches', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 1, force: false, scenarios: ['warm_reuse']});
			const baseline = baselineOf({
				compatibility: {workspaceKind: 'generated', profile: 'large', fileCountToleranceRatio: 0.05, symbolCountToleranceRatio: 0.05},
				requiredScenarios: [],
			});
			const evaluation = evaluateBenchmark(report, baseline);

			expect(evaluation.status).toBe('failure');
			expect(evaluation.gates.find((entry) => entry.code === 'compatibility.workspace_kind')?.status).toBe('failure');
			expect(evaluation.gates.find((entry) => entry.code === 'compatibility.workspace_profile')?.status).toBe('failure');
		} finally {
			fixture.cleanup();
		}
	});

	it('checks generated corpus counts without a reference', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 1, force: false, scenarios: ['warm_reuse']});
			const expected = benchmarkCorpusCounts('small');
			const baseline = baselineOf({
				compatibility: {workspaceKind: 'generated', profile: 'small', fileCountToleranceRatio: 0.05, symbolCountToleranceRatio: 0.05},
				requiredScenarios: [],
			});
			const drifted: BenchmarkReportType = {
				...report,
				workspace: {...report.workspace, kind: 'generated', profile: 'small', fileCount: expected.fileCount + 100, symbolCount: expected.symbolCount},
			};
			const evaluation = evaluateBenchmark(drifted, baseline);

			expect(evaluation.gates.find((entry) => entry.code === 'compatibility.file_count')?.status).toBe('failure');
			expect(evaluation.gates.find((entry) => entry.code === 'compatibility.symbol_count')?.status).toBe('pass');
		} finally {
			fixture.cleanup();
		}
	});

	it('rejects an obsolete or unrelated reference before relative gates run', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 1, force: false, scenarios: ['warm_reuse']});
			const base = referenceOf(report);
			const obsolete = evaluateBenchmark(report, baselineOf({reference: {...base, reportSchemaVersion: 1}, requiredScenarios: []}));
			const unrelated = evaluateBenchmark(
				report,
				baselineOf({
					reference: {
						...base,
						workspace: {kind: 'generated', profile: 'large', ...benchmarkCorpusCounts('large')},
					},
					requiredScenarios: [],
				}),
			);

			expect(obsolete.gates.find((entry) => entry.code === 'compatibility.reference_schema')?.status).toBe('failure');
			expect(obsolete.gates.find((entry) => entry.code === 'regression.reference')?.status).toBe('skipped');
			expect(unrelated.gates.find((entry) => entry.code === 'compatibility.reference_workspace_kind')?.status).toBe('failure');
			expect(unrelated.gates.find((entry) => entry.code === 'compatibility.reference_workspace_profile')?.status).toBe('failure');
		} finally {
			fixture.cleanup();
		}
	});

	it('fails a compatible report when a relative gate exceeds its failure ratio', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 1, force: false, scenarios: ['deep_cursor']});
			const baseline = baselineOf({
				reference: referenceOf(report),
				thresholds: {
					buildWarningRatio: 1,
					buildFailureRatio: 1,
					latencySlackMs: 0,
					memorySlackBytes: 0,
					cpuSlackMs: 0,
					storageSlackBytes: 0,
				},
			});
			const evaluation = evaluateBenchmark(report, baseline);

			expect(evaluation.status).toBe('failure');
			expect(evaluation.gates.find((entry) => entry.code === 'regression.cold_build.wall')?.status).toBe('failure');
		} finally {
			fixture.cleanup();
		}
	});

	it('enforces relative failures on the same platform despite a CPU-model mismatch', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 1, force: false, scenarios: ['deep_cursor']});
			const reference = referenceOf(report);
			const baseline = (machine: Readonly<Record<string, string>>): BenchmarkBaselineType =>
				baselineOf({
					reference: {...reference, machine: {...reference.machine, ...machine}},
					thresholds: {
						buildWarningRatio: 1,
						buildFailureRatio: 1,
						latencySlackMs: 0,
						memorySlackBytes: 0,
						cpuSlackMs: 0,
						storageSlackBytes: 0,
					},
				});
			const samePlatform = evaluateBenchmark(report, baseline({cpuModel: 'different-cpu'}));
			const otherPlatform = evaluateBenchmark(report, baseline({platform: 'other-platform'}));

			expect(samePlatform.gates.find((entry) => entry.code === 'regression.cold_build.wall')?.status).toBe('failure');
			expect(otherPlatform.gates.find((entry) => entry.code === 'regression.cold_build.wall')?.status).toBe('warning');
		} finally {
			fixture.cleanup();
		}
	});

	it('builds a Markdown summary from the same gate results', async () => {
		const fixture = createFixtureConfig('simple-project');

		try {
			const report = await runBenchmarkReport({config: fixture.config, iterations: 1, force: false, scenarios: ['deep_cursor']});
			const evaluation = evaluateBenchmark(brokenPlan(report), baselineOf());
			const summary = buildBenchmarkSummary(report, evaluation);

			expect(summary).toContain('**FAILURE**');
			expect(summary).toContain('| plan.index_usage |');
			expect(summary).toContain('## Scenarios');
			expect(summary).toContain('## Queries');
		} finally {
			fixture.cleanup();
		}
	});
});

describe('benchmark workspace retention', () => {
	it('keeps the generated corpus and temporary database when requested', async () => {
		const directory = tempDirectory('codeindex-benchmark-keep-');
		const output = path.join(directory, 'report.json');
		const baselinePath = path.join(directory, 'baseline.json');
		const evaluationPath = path.join(directory, 'evaluation.json');
		const summaryPath = path.join(directory, 'summary.md');
		const stdout: string[] = [];
		const stderr: string[] = [];
		let workspace: string | undefined;
		let database: string | undefined;

		try {
			writeJson(baselinePath, {
				schemaVersion: 1,
				reportSchemaVersion: 2,
				compatibility: {workspaceKind: 'generated', profile: 'small'},
				requiredScenarios: ['cold_build'],
				thresholds: {},
			});
			const exitCode = await runBenchmarkCommand(
				[
					'--profile',
					'small',
					'--scenarios',
					'warm',
					'--iterations',
					'1',
					'--keep-workspace',
					'--baseline',
					baselinePath,
					'--evaluation',
					evaluationPath,
					'--summary',
					summaryPath,
					'--output',
					output,
				],
				{},
				{
					stdout: (line) => {
						stdout.push(line);
					},
					stderr: (line) => {
						stderr.push(line);
					},
				},
			);
			workspace = stdout.find((line) => line.startsWith('Workspace: '))?.slice('Workspace: '.length);
			database = stdout.find((line) => line.startsWith('Database: '))?.slice('Database: '.length);

			expect(exitCode).toBe(0);
			expect(stderr).toStrictEqual([]);
			expect(existsSync(output)).toBe(true);
			expect(existsSync(evaluationPath)).toBe(true);
			expect(existsSync(summaryPath)).toBe(true);
			expect(workspace).toBeDefined();
			expect(database).toBeDefined();
			expect(existsSync(workspace ?? '')).toBe(true);
			expect(existsSync(database ?? '')).toBe(true);
		} finally {
			if (workspace !== undefined) {
				rmSync(workspace, {recursive: true, force: true});
			}

			if (database !== undefined) {
				rmSync(path.dirname(database), {recursive: true, force: true});
			}

			rmSync(directory, {recursive: true, force: true});
		}
	});
});
