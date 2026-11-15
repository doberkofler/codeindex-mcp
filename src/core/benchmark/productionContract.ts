import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {z} from 'zod';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/u;

export const PRODUCTION_SCENARIOS = [
	'cold_full_build',
	'warm_unchanged_refresh',
	'typescript_edit',
	'oracle_edit',
	'burst_supersession',
	'two_process_contention',
	'worker_idle_memory',
	'process_restart',
] as const;

const ProductionScenarioSchema = z.enum(PRODUCTION_SCENARIOS);
const HashSchema = z.string().regex(HASH_PATTERN);
const IdentifierSchema = z.string().min(1).max(128).regex(ID_PATTERN);
const DurationSchema = z.number().nonnegative();
const CountSchema = z.number().int().nonnegative();

const EngineSchema = z
	.object({
		entry: z.string().min(1).max(1024),
		revision: z.string().regex(REVISION_PATTERN),
		bundleSha256: HashSchema,
	})
	.strict();

const RuntimeSchema = z
	.object({
		nodeVersion: z.string().min(1).max(64),
		platform: IdentifierSchema,
		arch: IdentifierSchema,
	})
	.strict();

const EditScenarioSchema = z
	.object({
		adapterId: z.enum(['typescript', 'oracle']),
		target: z.string().min(1).max(1024),
		mutationSha256: HashSchema,
	})
	.strict();

/**
 * Frozen production-scale benchmark inputs.
 *
 * The manifest may contain consumer-workspace paths because it remains outside
 * this repository. Reports contain only hashes and closed identifiers.
 */
export const ProductionBenchmarkManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: IdentifierSchema,
		declaredAt: z.iso.datetime(),
		evidenceExpiresAt: z.iso.datetime(),
		engines: z.object({control: EngineSchema, candidate: EngineSchema}).strict(),
		runtime: RuntimeSchema,
		execution: z
			.object({
				workspace: z.literal('disposable_copy'),
				database: z.literal('temporary_sqlite'),
				scenarioTimeoutMs: z.number().int().positive().max(7_200_000),
				pollIntervalMs: z.number().int().positive().max(10_000),
				rssSampleIntervalMs: z.number().int().positive().max(60_000),
				processTreeSampleIntervalMs: z.number().int().positive().max(60_000),
			})
			.strict(),
		corpus: z
			.object({
				snapshot: z.string().min(1).max(1024),
				configuration: z.string().min(1).max(1024),
				sha256: HashSchema,
				configurationSha256: HashSchema,
			})
			.strict(),
		thresholds: z.object({path: z.string().min(1).max(1024), sha256: HashSchema}).strict(),
		warmups: CountSchema.max(20),
		repetitions: z.number().int().min(1).max(100),
		scenarioOrder: z.array(ProductionScenarioSchema).length(PRODUCTION_SCENARIOS.length),
		scenarios: z
			.object({
				typescriptEdit: EditScenarioSchema,
				oracleEdit: EditScenarioSchema,
				burstSupersession: z
					.object({
						edits: z.number().int().min(2).max(1000),
						intervalMs: CountSchema.max(60_000),
					})
					.strict(),
				twoProcessContention: z
					.object({
						processes: z.literal(2),
						startSkewMs: CountSchema.max(60_000),
					})
					.strict(),
				workerIdleMemory: z
					.object({
						durationMs: z.number().int().positive().max(3_600_000),
						sampleIntervalMs: z.number().int().positive().max(60_000),
					})
					.strict(),
				processRestart: z
					.object({
						shutdownTimeoutMs: z.number().int().positive().max(3_600_000),
						restartDelayMs: CountSchema.max(60_000),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.superRefine((manifest, context) => {
		if (Date.parse(manifest.evidenceExpiresAt) <= Date.parse(manifest.declaredAt)) {
			context.addIssue({
				code: 'custom',
				path: ['evidenceExpiresAt'],
				message: 'evidenceExpiresAt must be later than declaredAt',
			});
		}

		if (
			manifest.scenarioOrder.some((scenario, index) => scenario !== PRODUCTION_SCENARIOS[index]) ||
			new Set(manifest.scenarioOrder).size !== PRODUCTION_SCENARIOS.length
		) {
			context.addIssue({
				code: 'custom',
				path: ['scenarioOrder'],
				message: 'scenarioOrder must contain every production scenario in canonical order',
			});
		}

		if (manifest.scenarios.typescriptEdit.adapterId !== 'typescript') {
			context.addIssue({
				code: 'custom',
				path: ['scenarios', 'typescriptEdit', 'adapterId'],
				message: 'typescriptEdit must target the TypeScript adapter',
			});
		}

		if (manifest.scenarios.oracleEdit.adapterId !== 'oracle') {
			context.addIssue({
				code: 'custom',
				path: ['scenarios', 'oracleEdit', 'adapterId'],
				message: 'oracleEdit must target the Oracle adapter',
			});
		}
	});

const StageDurationsSchema = z
	.object({
		probeMs: DurationSchema,
		scanMs: DurationSchema,
		compilerMs: DurationSchema,
		extractionMs: DurationSchema,
		finalizationMs: DurationSchema,
		insertionMs: DurationSchema,
		verificationMs: DurationSchema,
		publicationMs: DurationSchema,
		checkpointMs: DurationSchema,
		maintenanceMs: DurationSchema,
	})
	.strict();

const ResourcesSchema = z
	.object({
		processRssStartBytes: CountSchema,
		processRssPeakBytes: CountSchema,
		processRssEndBytes: CountSchema,
		processTreeRssStartBytes: CountSchema,
		processTreeRssPeakBytes: CountSchema,
		processTreeRssEndBytes: CountSchema,
		processTreeRssIdleBytes: CountSchema,
		stageBoundaries: z
			.array(
				z
					.object({
						stage: z.enum([
							'start',
							'probe',
							'scan',
							'compiler',
							'extraction',
							'finalization',
							'insertion',
							'verification',
							'publication',
							'checkpoint',
							'maintenance',
							'complete',
							'idle',
						]),
						processRssBytes: CountSchema,
						processTreeRssBytes: CountSchema,
					})
					.strict(),
			)
			.min(2),
	})
	.strict();

const StorageSchema = z
	.object({
		databaseBytes: CountSchema,
		walBytes: CountSchema,
		shmBytes: CountSchema,
	})
	.strict();

const FactCountsSchema = z
	.object({
		digested: CountSchema,
		selected: CountSchema,
		deleted: CountSchema,
		written: CountSchema,
		validated: CountSchema,
	})
	.strict();

const AdapterCountersSchema = z
	.object({
		adapterId: IdentifierSchema,
		probes: CountSchema,
		scans: CountSchema,
		extractions: CountSchema,
		factWrites: CountSchema,
	})
	.strict();

const ScenarioRunSchema = z
	.object({
		scenario: ProductionScenarioSchema,
		repetition: z.number().int().min(1).max(100),
		ownerDurationMs: DurationSchema,
		observerWaitMs: DurationSchema,
		eventToPublicationMs: DurationSchema,
		stages: StageDurationsSchema,
		resources: ResourcesSchema,
		storage: StorageSchema,
		facts: FactCountsSchema,
		adapters: z.array(AdapterCountersSchema),
		supersession: z
			.object({
				started: CountSchema,
				published: CountSchema,
				discarded: CountSchema,
				discardedDurationMs: DurationSchema,
			})
			.strict(),
		digests: z.object({factsSha256: HashSchema, queryResultsSha256: HashSchema}).strict(),
	})
	.strict()
	.superRefine((run, context) => {
		if (new Set(run.adapters.map((adapter) => adapter.adapterId)).size !== run.adapters.length) {
			context.addIssue({code: 'custom', path: ['adapters'], message: 'adapter counters must be unique by adapterId'});
		}

		if (run.supersession.published + run.supersession.discarded > run.supersession.started) {
			context.addIssue({
				code: 'custom',
				path: ['supersession'],
				message: 'published and discarded attempts cannot exceed started attempts',
			});
		}
	});

export const ProductionBenchmarkReportSchema = z
	.object({
		schemaVersion: z.literal(1),
		manifestSha256: HashSchema,
		engine: z.object({role: z.enum(['control', 'candidate']), revision: z.string().regex(REVISION_PATTERN), bundleSha256: HashSchema}).strict(),
		runtime: RuntimeSchema,
		corpus: z.object({sha256: HashSchema, configurationSha256: HashSchema}).strict(),
		thresholdsSha256: HashSchema,
		startedAt: z.iso.datetime(),
		completedAt: z.iso.datetime(),
		complete: z.literal(true),
		warmups: CountSchema.max(20),
		repetitions: z.number().int().min(1).max(100),
		scenarioOrder: z.array(ProductionScenarioSchema).length(PRODUCTION_SCENARIOS.length),
		runs: z.array(ScenarioRunSchema).min(PRODUCTION_SCENARIOS.length),
	})
	.strict()
	.superRefine((report, context) => {
		if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
			context.addIssue({code: 'custom', path: ['completedAt'], message: 'completedAt must not precede startedAt'});
		}
	});

export type ProductionBenchmarkManifestType = z.infer<typeof ProductionBenchmarkManifestSchema>;
export type ProductionBenchmarkReportType = z.infer<typeof ProductionBenchmarkReportSchema>;
export type ProductionScenarioType = z.infer<typeof ProductionScenarioSchema>;

const canonicalValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalValue(entry));
	}

	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}

	return value;
};

/**
 * Hashes facts or query results without retaining their source-bearing values.
 *
 * Object keys are sorted recursively; array order remains semantically
 * significant.
 *
 * @param value - Serializable semantic result.
 * @returns Canonical SHA-256.
 */
export const productionSemanticDigest = (value: unknown): string =>
	createHash('sha256')
		.update(JSON.stringify(canonicalValue(value)))
		.digest('hex');

/**
 * Returns a location-independent SHA-256 identity for a parsed manifest.
 *
 * @param manifest - Validated frozen benchmark inputs.
 * @returns Canonical manifest SHA-256.
 */
export const productionManifestDigest = (manifest: ProductionBenchmarkManifestType): string => productionSemanticDigest(manifest);

const parseFile = <ValueType>(filePath: string, schema: z.ZodType<ValueType>, label: string): ValueType => {
	const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	const result = schema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid ${label} ${filePath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

/**
 * Loads a frozen production benchmark manifest.
 *
 * @param filePath - JSON manifest path.
 * @returns Validated manifest.
 */
export const loadProductionBenchmarkManifest = (filePath: string): ProductionBenchmarkManifestType =>
	parseFile(filePath, ProductionBenchmarkManifestSchema, 'production benchmark manifest');

/**
 * Loads a complete production benchmark report.
 *
 * @param filePath - JSON report path.
 * @returns Validated report.
 */
export const loadProductionBenchmarkReport = (filePath: string): ProductionBenchmarkReportType =>
	parseFile(filePath, ProductionBenchmarkReportSchema, 'production benchmark report');
