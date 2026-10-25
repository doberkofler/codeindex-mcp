import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {type BenchmarkReportType, type BenchmarkScenarioResultType} from './benchTypes.ts';
import {summarize} from './percentiles.ts';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

const UnitSchema = z.enum(['ms', 'bytes', 'count', 'percent']);
const StatisticSchema = z.enum(['median', 'p95', 'max']);

const ThresholdSchema = z
	.object({
		statistic: StatisticSchema,
		warn: z.number().nonnegative(),
		fail: z.number().nonnegative(),
		unit: UnitSchema,
	})
	.superRefine((value, context) => {
		if (value.warn >= value.fail) {
			context.addIssue({code: 'custom', path: ['warn'], message: 'warn must be lower than fail'});
		}
	});

const VarianceThresholdSchema = z
	.object({
		warnCvPercent: z.number().positive(),
		failCvPercent: z.number().positive(),
	})
	.superRefine((value, context) => {
		if (value.warnCvPercent >= value.failCvPercent) {
			context.addIssue({code: 'custom', path: ['warnCvPercent'], message: 'warnCvPercent must be lower than failCvPercent'});
		}
	});

const CorpusSchema = z.object({
	bundle: z.string().min(1),
	sourceHash: z.string().regex(HASH_PATTERN),
	configHash: z.string().regex(HASH_PATTERN),
	fileCount: z.number().int().positive(),
});

/**
 * Absolute production thresholds declared before the first measurement.
 *
 * Every metric names the aggregate statistic that the gate inspects. Variance
 * gates use the coefficient of variation of the measured runs.
 */
export const OraclePerformanceThresholdsSchema = z
	.object({
		schemaVersion: z.literal(1),
		declaredAt: z.string().min(1),
		declaration: z.string().min(1).optional(),
		corpus: CorpusSchema,
		metrics: z.record(z.string(), ThresholdSchema),
		variance: z.record(z.string(), VarianceThresholdSchema).default({}),
	})
	.refine((value) => Object.keys(value.metrics).length > 0, {
		message: 'at least one metric threshold is required',
		path: ['metrics'],
	});

export type OraclePerformanceThresholdsType = z.infer<typeof OraclePerformanceThresholdsSchema>;
type OraclePerformanceUnitType = z.infer<typeof UnitSchema>;
type OraclePerformanceStatisticType = z.infer<typeof StatisticSchema>;

export type OraclePerformanceAggregateType = Readonly<{
	readonly count: number;
	readonly min: number;
	readonly median: number;
	readonly p95: number;
	readonly max: number;
	readonly mean: number;
	readonly cvPercent: number;
	readonly samples: readonly number[];
}>;

export type OraclePerformanceBundlesType = Readonly<Record<'mcp' | 'cli', Readonly<{rawBytes: number; gzipBytes: number}>>>;

export type OraclePerformanceRunType = Readonly<{
	readonly cold: BenchmarkReportType;
	readonly warm: BenchmarkReportType;
	readonly rebuild: BenchmarkReportType;
	readonly edit: BenchmarkReportType;
	readonly deep: BenchmarkReportType;
}>;

type OraclePerformanceGateStatusType = 'pass' | 'warning' | 'failure';

export type OraclePerformanceGateType = Readonly<{
	readonly code: string;
	readonly status: OraclePerformanceGateStatusType;
	readonly category: 'absolute' | 'variance' | 'integrity';
	readonly metric: string | null;
	readonly statistic: OraclePerformanceStatisticType | null;
	readonly actual: number;
	readonly warning: number | null;
	readonly failure: number | null;
	readonly unit: OraclePerformanceUnitType | null;
	readonly message: string;
}>;

export type OraclePerformanceEvaluationType = Readonly<{
	readonly status: OraclePerformanceGateStatusType;
	readonly summary: Readonly<{pass: number; warning: number; failure: number}>;
	readonly gates: readonly OraclePerformanceGateType[];
}>;

/**
 * Loads and validates a declared threshold file.
 *
 * @param filePath - Threshold JSON path.
 * @returns Parsed thresholds.
 * @throws {@link Error} When the file is unreadable or invalid.
 */
export const loadOraclePerformanceThresholds = (filePath: string): OraclePerformanceThresholdsType => {
	const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	const result = OraclePerformanceThresholdsSchema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid Oracle performance thresholds ${filePath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

const scenarioOf = (report: BenchmarkReportType, name: BenchmarkScenarioResultType['name']): BenchmarkScenarioResultType => {
	const scenario = report.scenarios.find((entry) => entry.name === name);

	if (scenario === undefined) {
		throw new Error(`Benchmark report ${report.generatedAt} has no ${name} scenario`);
	}

	return scenario;
};

const buildOf = (report: BenchmarkReportType, name: 'cold_build' | 'warm_reuse' | 'warm_rebuild'): Extract<BenchmarkScenarioResultType, {kind: 'build'}> => {
	const scenario = scenarioOf(report, name);

	if (scenario.kind !== 'build') {
		throw new Error(`Benchmark scenario ${name} is not a build`);
	}

	return scenario;
};

const editOf = (report: BenchmarkReportType): Extract<BenchmarkScenarioResultType, {kind: 'edit'}> => {
	const scenario = scenarioOf(report, 'edit_to_fresh');

	if (scenario.kind !== 'edit') {
		throw new Error('Benchmark scenario edit_to_fresh is not an edit');
	}

	return scenario;
};

const cursorOf = (report: BenchmarkReportType): Extract<BenchmarkScenarioResultType, {kind: 'cursor'}> => {
	const scenario = scenarioOf(report, 'deep_cursor');

	if (scenario.kind !== 'cursor') {
		throw new Error('Benchmark scenario deep_cursor is not a cursor');
	}

	return scenario;
};

const queryNamesOf = (reports: readonly BenchmarkReportType[]): readonly string[] => {
	const names = new Set<string>();

	for (const report of reports) {
		for (const name of Object.keys(report.queries)) {
			names.add(name);
		}
	}

	return [...names].sort((left, right) => left.localeCompare(right));
};

const queryP95Of = (report: BenchmarkReportType, name: string): number => {
	const value = report.queries[name]?.p95Ms;

	if (value === null || value === undefined) {
		throw new Error(`Benchmark report ${report.generatedAt} has no ${name} p95 query measurement`);
	}

	return value;
};

/**
 * Flattens measured benchmark reports into named sample sets.
 *
 * Measurements that appear once per run (builds, scenario wall times, bundles)
 * contribute one sample per run. Edit-to-fresh contributes its per-run
 * percentiles and every individual write-to-fresh latency.
 *
 * @param input - Measured runs and built bundle sizes.
 * @returns Metric name to observed values.
 */
export const collectOraclePerformanceSamples = (
	input: Readonly<{
		runs: readonly OraclePerformanceRunType[];
		bundles: OraclePerformanceBundlesType;
	}>,
): Readonly<Record<string, readonly number[]>> => {
	const cold = input.runs.map((run) => buildOf(run.cold, 'cold_build'));
	const warm = input.runs.map((run) => buildOf(run.warm, 'warm_reuse'));
	const rebuild = input.runs.map((run) => buildOf(run.rebuild, 'warm_rebuild'));
	const edits = input.runs.map((run) => editOf(run.edit));
	const deep = input.runs.map((run) => cursorOf(run.deep));
	const samples: Record<string, readonly number[]> = {
		'cold.wallMs': cold.map((scenario) => scenario.wallMs),
		'cold.buildMs': cold.map((scenario) => scenario.build.durationMs),
		'cold.cpuMs': cold.map((scenario) => scenario.resources.cpuUserMs + scenario.resources.cpuSystemMs),
		'cold.rssPeakBytes': cold.map((scenario) => scenario.resources.rssPeakBytes),
		'cold.storageTotalBytes': cold.map((scenario) => scenario.storage.totalBytes),
		'cold.databaseBytes': cold.map((scenario) => scenario.storage.databaseBytes),
		'warm.wallMs': warm.map((scenario) => scenario.wallMs),
		'warm.cpuMs': warm.map((scenario) => scenario.resources.cpuUserMs + scenario.resources.cpuSystemMs),
		'warm.rssPeakBytes': warm.map((scenario) => scenario.resources.rssPeakBytes),
		'warm.storageTotalBytes': warm.map((scenario) => scenario.storage.totalBytes),
		'rebuild.wallMs': rebuild.map((scenario) => scenario.wallMs),
		'rebuild.buildMs': rebuild.map((scenario) => scenario.build.durationMs),
		'rebuild.cpuMs': rebuild.map((scenario) => scenario.resources.cpuUserMs + scenario.resources.cpuSystemMs),
		'rebuild.rssPeakBytes': rebuild.map((scenario) => scenario.resources.rssPeakBytes),
		'rebuild.storageTotalBytes': rebuild.map((scenario) => scenario.storage.totalBytes),
		'edit.p50Ms': edits.map((scenario) => scenario.percentiles.p50Ms ?? 0),
		'edit.p95Ms': edits.map((scenario) => scenario.percentiles.p95Ms ?? 0),
		'edit.maxMs': edits.map((scenario) => scenario.percentiles.maxMs ?? 0),
		'edit.latencyMs': edits.flatMap((scenario) => scenario.samples.map((sample) => sample.latencyMs)),
		'deep.wallMs': deep.map((scenario) => scenario.wallMs),
		'deep.rssPeakBytes': deep.map((scenario) => scenario.resources.rssPeakBytes),
		'bundle.mcp.rawBytes': [input.bundles.mcp.rawBytes],
		'bundle.mcp.gzipBytes': [input.bundles.mcp.gzipBytes],
		'bundle.cli.rawBytes': [input.bundles.cli.rawBytes],
		'bundle.cli.gzipBytes': [input.bundles.cli.gzipBytes],
	};

	const deepReports = input.runs.map((run) => run.deep);

	for (const name of queryNamesOf(deepReports)) {
		samples[`queries.${name}.p95Ms`] = deepReports.map((report) => queryP95Of(report, name));
	}

	return samples;
};

const meanOf = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0) / values.length;

const standardDeviationOf = (values: readonly number[], mean: number): number => {
	const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
	return Math.sqrt(variance);
};

/**
 * Summarizes one named sample set with median, tail, and variance.
 *
 * @param values - Observed values.
 * @returns Aggregate with the retained samples.
 * @throws {@link Error} When the sample is empty.
 */
export const aggregateOraclePerformance = (values: readonly number[]): OraclePerformanceAggregateType => {
	if (values.length === 0) {
		throw new Error('Cannot aggregate an empty performance sample');
	}

	const summary = summarize(values);
	const mean = meanOf(values);
	const cvPercent = mean === 0 ? 0 : (standardDeviationOf(values, mean) / mean) * 100;

	return {
		count: values.length,
		min: Math.min(...values),
		median: summary.p50Ms ?? 0,
		p95: summary.p95Ms ?? 0,
		max: summary.maxMs ?? 0,
		mean,
		cvPercent,
		samples: [...values],
	};
};

/**
 * Aggregates every collected metric.
 *
 * Used by the standalone Oracle evidence harness.
 *
 * @public
 * @param samples - Metric name to observed values.
 * @returns Aggregate by metric name.
 */
export const aggregateOraclePerformanceSamples = (
	samples: Readonly<Record<string, readonly number[]>>,
): Readonly<Record<string, OraclePerformanceAggregateType>> =>
	Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, aggregateOraclePerformance(values)]));

const statusOf = (actual: number, warning: number, failure: number): OraclePerformanceGateStatusType =>
	actual > failure ? 'failure' : actual > warning ? 'warning' : 'pass';

const metricGate = (
	threshold: OraclePerformanceThresholdsType['metrics'][string],
	name: string,
	aggregate: OraclePerformanceAggregateType,
): OraclePerformanceGateType => {
	const actual = aggregate[threshold.statistic];

	return {
		code: `metric.${name}`,
		status: statusOf(actual, threshold.warn, threshold.fail),
		category: 'absolute',
		metric: name,
		statistic: threshold.statistic,
		actual,
		warning: threshold.warn,
		failure: threshold.fail,
		unit: threshold.unit,
		message: `${name} ${threshold.statistic} ${String(actual)} ${threshold.unit}; warning above ${String(threshold.warn)}, failure above ${String(threshold.fail)}`,
	};
};

const varianceGate = (
	threshold: OraclePerformanceThresholdsType['variance'][string],
	name: string,
	aggregate: OraclePerformanceAggregateType,
): OraclePerformanceGateType => ({
	code: `variance.${name}`,
	status: statusOf(aggregate.cvPercent, threshold.warnCvPercent, threshold.failCvPercent),
	category: 'variance',
	metric: name,
	statistic: null,
	actual: aggregate.cvPercent,
	warning: threshold.warnCvPercent,
	failure: threshold.failCvPercent,
	unit: 'percent',
	message: `${name} coefficient of variation ${aggregate.cvPercent.toFixed(2)}%; warning above ${String(threshold.warnCvPercent)}, failure above ${String(threshold.failCvPercent)}`,
});

const combine = (gates: readonly OraclePerformanceGateType[]): OraclePerformanceEvaluationType => {
	const summary = {
		pass: gates.filter((gate) => gate.status === 'pass').length,
		warning: gates.filter((gate) => gate.status === 'warning').length,
		failure: gates.filter((gate) => gate.status === 'failure').length,
	};

	return {
		status: summary.failure > 0 ? 'failure' : summary.warning > 0 ? 'warning' : 'pass',
		summary,
		gates,
	};
};

/**
 * Evaluates declared absolute and variance gates.
 *
 * Every declared metric must be present. A missing metric is a failure: it
 * means the declared baseline and the retained evidence measure different
 * surfaces.
 *
 * @param input - Aggregates, thresholds, and optional integrity checks.
 * @returns Ordered gates and the combined verdict.
 */
export const evaluateOraclePerformance = (
	input: Readonly<{
		aggregates: Readonly<Record<string, OraclePerformanceAggregateType>>;
		thresholds: OraclePerformanceThresholdsType;
		integrity?: readonly OraclePerformanceGateType[];
	}>,
): OraclePerformanceEvaluationType => {
	const gates: OraclePerformanceGateType[] = [...(input.integrity ?? [])];

	for (const [name, threshold] of Object.entries(input.thresholds.metrics)) {
		const aggregate = input.aggregates[name];

		if (aggregate === undefined) {
			gates.push({
				code: `metric.${name}`,
				status: 'failure',
				category: 'absolute',
				metric: name,
				statistic: threshold.statistic,
				actual: 0,
				warning: threshold.warn,
				failure: threshold.fail,
				unit: threshold.unit,
				message: `${name} was declared but not measured`,
			});
			continue;
		}

		gates.push(metricGate(threshold, name, aggregate));
	}

	for (const [name, threshold] of Object.entries(input.thresholds.variance)) {
		const aggregate = input.aggregates[name];

		if (aggregate === undefined) {
			gates.push({
				code: `variance.${name}`,
				status: 'failure',
				category: 'variance',
				metric: name,
				statistic: null,
				actual: 0,
				warning: threshold.warnCvPercent,
				failure: threshold.failCvPercent,
				unit: 'percent',
				message: `${name} variance was declared but not measured`,
			});
			continue;
		}

		gates.push(varianceGate(threshold, name, aggregate));
	}

	return combine(gates);
};

const integrityGate = (
	input: Readonly<{
		code: string;
		status: OraclePerformanceGateStatusType;
		message: string;
		violations: number;
		total: number;
	}>,
): OraclePerformanceGateType => ({
	code: input.code,
	status: input.status,
	category: 'integrity',
	metric: null,
	statistic: null,
	actual: input.violations,
	message: `${input.message}; ${String(input.violations)} of ${String(input.total)} runs violated the contract`,
	warning: null,
	failure: 0,
	unit: 'count',
});

/**
 * Verifies that every measured run used the frozen corpus and the expected
 * reuse, edit, and query paths.
 *
 * @param input - Measured runs and expected frozen identities.
 * @returns Integrity gates, one per verified contract.
 */
export const verifyOraclePerformanceRuns = (
	input: Readonly<{
		runs: readonly OraclePerformanceRunType[];
		expected: Readonly<{sourceHash: string; configHash: string; fileCount: number; editRounds: number}>;
	}>,
): readonly OraclePerformanceGateType[] => {
	const gates: OraclePerformanceGateType[] = [];

	const sourceMismatches = input.runs.filter((run) => run.cold.workspace.sourceHash !== input.expected.sourceHash).length;
	const configMismatches = input.runs.filter((run) => run.cold.workspace.configHash !== input.expected.configHash).length;
	const fileMismatches = input.runs.filter((run) => run.cold.workspace.fileCount !== input.expected.fileCount).length;
	const coldReuseMismatches = input.runs.filter((run) => buildOf(run.cold, 'cold_build').reuse.generationReused).length;
	const warmReuseMismatches = input.runs.filter((run) => {
		const scenario = buildOf(run.warm, 'warm_reuse');
		return !scenario.reuse.generationReused || scenario.reuse.filesReused !== scenario.reuse.filesTotal;
	}).length;
	const rebuildReuseMismatches = input.runs.filter((run) => {
		const scenario = buildOf(run.rebuild, 'warm_rebuild');
		return scenario.reuse.generationReused || scenario.reuse.filesReused !== scenario.reuse.filesTotal;
	}).length;
	const editSampleMismatches = input.runs.filter((run) => editOf(run.edit).samples.length !== input.expected.editRounds).length;
	const cursorPlanMismatches = input.runs.filter((run) => cursorOf(run.deep).samples.some((sample) => !sample.usesIndex)).length;
	const cursorBTreeWarnings = input.runs.filter((run) => cursorOf(run.deep).samples.some((sample) => sample.usesTempBTree)).length;
	const queryMismatches = input.runs.filter((run) => Object.values(run.deep.queries).some((query) => query.count !== run.deep.iterations)).length;

	const total = input.runs.length;
	const check = (code: string, status: OraclePerformanceGateStatusType, message: string, violations: number): OraclePerformanceGateType =>
		integrityGate({code, status, message, violations, total});

	gates.push(
		check('integrity.cold.sourceHash', sourceMismatches === 0 ? 'pass' : 'failure', 'cold builds used the frozen source', sourceMismatches),
		check('integrity.cold.configHash', configMismatches === 0 ? 'pass' : 'failure', 'cold builds used the frozen configuration', configMismatches),
		check('integrity.cold.fileCount', fileMismatches === 0 ? 'pass' : 'failure', 'cold builds indexed the frozen file count', fileMismatches),
		check('integrity.cold.generationReuse', coldReuseMismatches === 0 ? 'pass' : 'failure', 'cold builds created a generation', coldReuseMismatches),
		check('integrity.warm.reuse', warmReuseMismatches === 0 ? 'pass' : 'failure', 'warm runs reused every content version', warmReuseMismatches),
		check(
			'integrity.rebuild.reuse',
			rebuildReuseMismatches === 0 ? 'pass' : 'failure',
			'full rebuilds reused content and published a generation',
			rebuildReuseMismatches,
		),
		check('integrity.edit.samples', editSampleMismatches === 0 ? 'pass' : 'failure', 'edits recorded every declared round', editSampleMismatches),
		check('integrity.deep_cursor.index', cursorPlanMismatches === 0 ? 'pass' : 'failure', 'deep cursor samples used an intended index', cursorPlanMismatches),
		check(
			'integrity.deep_cursor.temp_btree',
			cursorBTreeWarnings === 0 ? 'pass' : 'warning',
			'deep cursor samples avoided temporary B-trees',
			cursorBTreeWarnings,
		),
		check('integrity.queries.iterations', queryMismatches === 0 ? 'pass' : 'failure', 'every query recorded the declared iterations', queryMismatches),
	);

	return gates;
};
