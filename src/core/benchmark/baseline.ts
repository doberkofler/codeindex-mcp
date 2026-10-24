import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {BENCHMARK_SCENARIO_NAMES} from './benchTypes.ts';

const ReferenceScenarioSchema = z.object({
	kind: z.enum(['build', 'edit', 'cursor']),
	name: z.string().min(1),
	wallMs: z.number().min(0),
	resources: z.object({
		cpuUserMs: z.number().min(0),
		cpuSystemMs: z.number().min(0),
		rssPeakBytes: z.number().min(0),
	}),
	storage: z.object({totalBytes: z.number().min(0)}),
	percentiles: z.object({p95Ms: z.number().min(0).nullable()}).optional(),
	samples: z.array(z.object({elapsedMs: z.number().min(0)})).optional(),
});

const ReferenceQuerySchema = z.object({p95Ms: z.number().min(0).nullable()});
const ReferencePercentilesSchema = z.object({p95Ms: z.number().min(0).nullable()});
const ReferenceSampleSchema = z.object({elapsedMs: z.number().min(0)});
const ReportSampleSchema = z.union([ReferenceSampleSchema, z.object({latencyMs: z.number().min(0)})]);
const BenchmarkProfileSchema = z.enum(['small', 'medium', 'large', 'xl']);

/**
 * Report fields required to derive relative reference measurements.
 *
 * A stored reference and a raw benchmark report describe the same measurements
 * under different field names; accepting both keeps the documented
 * `--reference <report.json>` workflow working.
 */
const BenchmarkReportSourceSchema = z.object({
	schemaVersion: z.number().int().positive(),
	machine: z.object({
		platform: z.string().min(1),
		arch: z.string().min(1),
		cpuModel: z.string().min(1),
	}),
	workspace: z.object({
		kind: z.enum(['generated', 'external']),
		profile: BenchmarkProfileSchema.nullable(),
		fileCount: z.number().int().min(0),
		symbolCount: z.number().int().min(0),
	}),
	scenarios: z.array(
		z.object({
			kind: z.enum(['build', 'edit', 'cursor']),
			name: z.string().min(1),
			wallMs: z.number().min(0),
			resources: z.object({
				cpuUserMs: z.number().min(0),
				cpuSystemMs: z.number().min(0),
				rssPeakBytes: z.number().min(0),
			}),
			storage: z.object({totalBytes: z.number().min(0)}),
			percentiles: ReferencePercentilesSchema.optional(),
			samples: z.array(ReportSampleSchema).optional(),
		}),
	),
	queries: z.record(z.string(), ReferenceQuerySchema),
});

export const BenchmarkReferenceSchema = z
	.object({
		reportSchemaVersion: z.number().int().positive(),
		machine: z.object({
			platform: z.string().min(1),
			arch: z.string().min(1),
			cpuModel: z.string().min(1),
		}),
		workspace: z.object({
			kind: z.enum(['generated', 'external']),
			profile: BenchmarkProfileSchema.nullable(),
			fileCount: z.number().int().min(0),
			symbolCount: z.number().int().min(0),
		}),
		scenarios: z.array(ReferenceScenarioSchema),
		queries: z.record(z.string(), ReferenceQuerySchema),
	})
	.superRefine((reference, context) => {
		const generated = reference.workspace.kind === 'generated';

		if (generated !== (reference.workspace.profile !== null)) {
			context.addIssue({
				code: 'custom',
				path: ['workspace', 'profile'],
				message: 'generated references require a profile and external references must not have one',
			});
		}
	});

const CompatibilitySchema = z.object({
	workspaceKind: z.enum(['generated', 'external']).nullable().default('generated'),
	profile: BenchmarkProfileSchema.nullable().default(null),
	fileCountToleranceRatio: z.number().min(0).max(1).default(0.05),
	symbolCountToleranceRatio: z.number().min(0).max(1).default(0.05),
});

const ThresholdsSchema = z.object({
	buildWarningRatio: z.number().min(1).default(2),
	buildFailureRatio: z.number().min(1).default(5),
	editWarningRatio: z.number().min(1).default(2),
	editFailureRatio: z.number().min(1).default(5),
	editP95WarningMs: z.number().min(0).default(5000),
	editP95FailureMs: z.number().min(0).default(15_000),
	queryWarningRatio: z.number().min(1).default(5),
	queryFailureRatio: z.number().min(1).default(20),
	queryP95WarningMs: z.number().min(0).default(25),
	queryP95FailureMs: z.number().min(0).default(100),
	cursorItemWarningMs: z.number().min(0).default(0.75),
	cursorItemFailureMs: z.number().min(0).default(1.5),
	memoryWarningRatio: z.number().min(1).default(2),
	memoryFailureRatio: z.number().min(1).default(4),
	cpuWarningRatio: z.number().min(1).default(2),
	cpuFailureRatio: z.number().min(1).default(4),
	storageWarningRatio: z.number().min(1).default(2),
	storageFailureRatio: z.number().min(1).default(4),
	latencySlackMs: z.number().min(0).default(50),
	querySlackMs: z.number().min(0).default(5),
	memorySlackBytes: z.number().min(0).default(67_108_864),
	cpuSlackMs: z.number().min(0).default(100),
	storageSlackBytes: z.number().min(0).default(16_777_216),
});

const RATIO_PAIRS = [
	{warning: 'buildWarningRatio', failure: 'buildFailureRatio'},
	{warning: 'editWarningRatio', failure: 'editFailureRatio'},
	{warning: 'queryWarningRatio', failure: 'queryFailureRatio'},
	{warning: 'memoryWarningRatio', failure: 'memoryFailureRatio'},
	{warning: 'cpuWarningRatio', failure: 'cpuFailureRatio'},
	{warning: 'storageWarningRatio', failure: 'storageFailureRatio'},
] as const;

export const BenchmarkBaselineSchema = z
	.object({
		schemaVersion: z.literal(1),
		reportSchemaVersion: z.number().int().positive(),
		compatibility: CompatibilitySchema,
		requiredScenarios: z.array(z.enum(BENCHMARK_SCENARIO_NAMES)).default([...BENCHMARK_SCENARIO_NAMES]),
		thresholds: ThresholdsSchema,
		reference: BenchmarkReferenceSchema.nullable().default(null),
	})
	.superRefine((baseline, context) => {
		for (const pair of RATIO_PAIRS) {
			if (baseline.thresholds[pair.failure] < baseline.thresholds[pair.warning]) {
				context.addIssue({
					code: 'custom',
					path: ['thresholds', pair.failure],
					message: `${pair.failure} must be greater than or equal to ${pair.warning}`,
				});
			}
		}

		if (baseline.thresholds.editP95FailureMs < baseline.thresholds.editP95WarningMs) {
			context.addIssue({
				code: 'custom',
				path: ['thresholds', 'editP95FailureMs'],
				message: 'editP95FailureMs must be greater than or equal to editP95WarningMs',
			});
		}

		if (baseline.thresholds.queryP95FailureMs < baseline.thresholds.queryP95WarningMs) {
			context.addIssue({
				code: 'custom',
				path: ['thresholds', 'queryP95FailureMs'],
				message: 'queryP95FailureMs must be greater than or equal to queryP95WarningMs',
			});
		}

		if (baseline.thresholds.cursorItemFailureMs < baseline.thresholds.cursorItemWarningMs) {
			context.addIssue({
				code: 'custom',
				path: ['thresholds', 'cursorItemFailureMs'],
				message: 'cursorItemFailureMs must be greater than or equal to cursorItemWarningMs',
			});
		}
	});

export type BenchmarkBaselineType = z.infer<typeof BenchmarkBaselineSchema>;
export type BenchmarkReferenceType = z.infer<typeof BenchmarkReferenceSchema>;
export type BenchmarkReferenceScenarioType = BenchmarkReferenceType['scenarios'][number];

const parseJsonFile = <SchemaType extends z.ZodType>(filePath: string, schema: SchemaType, label: string): z.infer<SchemaType> => {
	const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	const result = schema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid ${label} ${filePath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

/**
 * Loads the versioned benchmark gate configuration.
 *
 * The reference object is optional. Relative regression gates run only when a
 * reference is present, either embedded here or supplied separately.
 *
 * @param filePath - Baseline JSON file.
 * @returns Parsed baseline with defaults applied.
 * @throws {@link Error} When the file is unreadable or invalid.
 */
export const loadBenchmarkBaseline = (filePath: string): BenchmarkBaselineType => parseJsonFile(filePath, BenchmarkBaselineSchema, 'benchmark baseline');

const referenceScenarioFromReport = (scenario: z.infer<typeof BenchmarkReportSourceSchema>['scenarios'][number]): BenchmarkReferenceScenarioType => ({
	kind: scenario.kind,
	name: scenario.name,
	wallMs: scenario.wallMs,
	resources: scenario.resources,
	storage: scenario.storage,
	...(scenario.percentiles === undefined ? {} : {percentiles: scenario.percentiles}),
	...(scenario.kind === 'cursor' && scenario.samples !== undefined
		? {samples: scenario.samples.flatMap((sample) => ('elapsedMs' in sample ? [{elapsedMs: sample.elapsedMs}] : []))}
		: {}),
});

const referenceFromReport = (report: z.infer<typeof BenchmarkReportSourceSchema>): BenchmarkReferenceType => ({
	reportSchemaVersion: report.schemaVersion,
	machine: report.machine,
	workspace: report.workspace,
	scenarios: report.scenarios.map(referenceScenarioFromReport),
	queries: report.queries,
});

/**
 * Loads an accepted benchmark report as a relative-regression reference.
 *
 * Both a raw benchmark report and a stored reference object are accepted.
 * Extra fields are ignored; the report schema version, machine, workspace
 * identity, scenario, and query measurements are retained.
 *
 * @param filePath - Benchmark report or reference JSON file.
 * @returns Parsed reference measurements.
 * @throws {@link Error} When the file is unreadable or invalid.
 */
export const loadBenchmarkReference = (filePath: string): BenchmarkReferenceType => {
	const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	const reference = BenchmarkReferenceSchema.safeParse(parsed);

	if (reference.success) {
		return reference.data;
	}

	const report = BenchmarkReportSourceSchema.safeParse(parsed);

	if (report.success) {
		return BenchmarkReferenceSchema.parse(referenceFromReport(report.data));
	}

	throw new Error(`Invalid benchmark reference ${filePath}:\n${z.prettifyError(reference.error)}`, {cause: reference.error});
};
