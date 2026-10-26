import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {type BenchmarkReportType} from '../src/core/benchmark/benchTypes.ts';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const BundleSchema = z.object({
	schemaVersion: z.literal(1),
	evidence: z.object({externalRoot: z.string().min(1), snapshotDir: z.string().min(1)}),
	snapshot: z.object({
		projectFile: z.string().min(1),
		sourceHash: HashSchema,
		configHash: HashSchema,
		fileCount: z.number().int().positive(),
		unitCount: z.number().int().positive(),
	}),
});

export type BundleType = z.infer<typeof BundleSchema>;

const PercentilesSchema = z.object({
	count: z.number().int().nonnegative(),
	p50Ms: z.number().nullable(),
	p95Ms: z.number().nullable(),
	p99Ms: z.number().nullable(),
	maxMs: z.number().nullable(),
});

const ResourcesSchema = z.object({
	cpuUserMs: z.number(),
	cpuSystemMs: z.number(),
	rssStartBytes: z.number(),
	rssPeakBytes: z.number(),
	rssEndBytes: z.number(),
	lifetimeMaxRssBytes: z.number(),
});

const StorageSchema = z.object({
	databaseBytes: z.number(),
	walBytes: z.number(),
	shmBytes: z.number(),
	totalBytes: z.number(),
	contentVersions: z.number().int(),
	extractionArtifacts: z.number().int(),
});

const ReuseSchema = z.object({
	generationReused: z.boolean(),
	filesTotal: z.number().int(),
	filesReused: z.number().int(),
	contentReuseRatio: z.number(),
	artifactRowsBefore: z.number().int(),
	artifactRowsAfter: z.number().int(),
	artifactRowsRead: z.number().int(),
	artifactReuseRatio: z.number(),
	artifactConsumption: z.enum(['not_implemented', 'none', 'parse_digest']),
});

const StagesSchema = z.object({
	scanMs: z.number(),
	compilerMs: z.number(),
	extractionMs: z.number(),
	insertionMs: z.number(),
	verificationMs: z.number(),
	publicationMs: z.number(),
});

const BuildSchema = z.object({reused: z.boolean(), durationMs: z.number(), stages: StagesSchema.nullable()});

const BuildScenarioSchema = z.object({
	kind: z.literal('build'),
	name: z.enum(['cold_build', 'warm_reuse', 'warm_rebuild']),
	wallMs: z.number(),
	generationId: z.string(),
	build: BuildSchema,
	resources: ResourcesSchema,
	storage: StorageSchema,
	reuse: ReuseSchema,
});

const EditScenarioSchema = z.object({
	kind: z.literal('edit'),
	name: z.literal('edit_to_fresh'),
	wallMs: z.number(),
	rounds: z.number().int(),
	debounceMs: z.number(),
	samples: z.array(z.object({iteration: z.number().int(), latencyMs: z.number(), generationId: z.string()})),
	percentiles: PercentilesSchema,
	build: BuildSchema.nullable(),
	resources: ResourcesSchema,
	storage: StorageSchema,
	reuse: ReuseSchema,
});

const CursorScenarioSchema = z.object({
	kind: z.literal('cursor'),
	name: z.literal('deep_cursor'),
	wallMs: z.number(),
	maxDepth: z.number().int(),
	pageLimit: z.number().int(),
	samples: z.array(
		z.object({
			kind: z.enum(['outline', 'find_symbol', 'find_references']),
			depth: z.number().int(),
			limit: z.number().int(),
			elapsedMs: z.number(),
			items: z.number().int(),
			bytes: z.number().int(),
			plan: z.array(z.string()),
			usesIndex: z.boolean(),
			usesTempBTree: z.boolean(),
		}),
	),
	resources: ResourcesSchema,
	storage: StorageSchema,
});

const ReportSchema = z.object({
	schemaVersion: z.literal(2),
	generatedAt: z.string(),
	machine: z.object({
		nodeVersion: z.string(),
		platform: z.string(),
		arch: z.string(),
		cpuModel: z.string(),
		totalMemoryBytes: z.number(),
	}),
	runtime: z.object({workerEntry: z.boolean(), scenariosInProcess: z.literal(true)}),
	workspace: z.object({
		kind: z.enum(['generated', 'external']),
		profile: z.enum(['small', 'medium', 'large', 'xl']).nullable(),
		projectId: z.string(),
		projectName: z.string(),
		fileCount: z.number().int(),
		symbolCount: z.number().int(),
		occurrenceCount: z.number().int(),
		dependencyEdgeCount: z.number().int(),
		sourceHash: z.string(),
		configHash: z.string(),
	}),
	iterations: z.number().int(),
	freshness: z.object({
		state: z.enum(['current', 'updating', 'stale', 'unknown']),
		checkedAt: z.string(),
		dirtyFileCount: z.number().nullable(),
	}),
	scenarios: z.array(z.union([BuildScenarioSchema, EditScenarioSchema, CursorScenarioSchema])),
	queries: z.record(z.string(), PercentilesSchema),
});

const PackageSchema = z.object({version: z.string().min(1)});

/**
 * Parses external JSON immediately through its schema.
 *
 * @param filePath - File to read.
 * @param schema - Schema that owns the external shape.
 * @returns Parsed value.
 * @throws {@link Error} When the file is unreadable or invalid.
 */
export const readJson = <SchemaType extends z.ZodType>(filePath: string, schema: SchemaType): z.infer<SchemaType> => {
	const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	const result = schema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid JSON in ${filePath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

export const loadBundle = (filePath: string): BundleType => readJson(filePath, BundleSchema);

export const loadReport = (filePath: string): BenchmarkReportType => readJson(filePath, ReportSchema);

export const loadPackageVersion = (filePath: string): string => readJson(filePath, PackageSchema).version;
