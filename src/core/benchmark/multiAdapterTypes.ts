import {z} from 'zod';

const AdapterCountersSchema = z.object({
	probes: z.number().int().min(0),
	scans: z.number().int().min(0),
	extractions: z.number().int().min(0),
	factWrites: z.number().int().min(0),
});

export type AdapterCountersType = z.infer<typeof AdapterCountersSchema>;

export type MultiAdapterEditSampleType = Readonly<{
	iteration: number;
	adapterId: 'typescript' | 'oracle';
	path: string;
	latencyMs: number;
	eventToPublicationMs: number;
	revision: number;
}>;

export type MultiAdapterIsolationRoundType = Readonly<{
	iteration: number;
	sourceAdapterId: 'typescript' | 'oracle';
	typescript: AdapterCountersType;
	oracle: AdapterCountersType;
}>;

export type MultiAdapterDiscardedAttemptType = Readonly<{
	attempt: number;
	cause: 'adapter-change' | 'project-wide' | 'manual' | 'unknown';
	stage: 'probe' | 'scan' | 'extraction' | 'publication' | 'unknown';
	adapterId: string | null;
	durationMs: number;
}>;

export type MultiAdapterSupersessionType = Readonly<{
	startedAttempts: number;
	attempts: number;
	discarded: readonly MultiAdapterDiscardedAttemptType[];
	discardedDurationMs: number;
	finalPublishedDurationMs: number;
}>;

export type MultiAdapterReportType = Readonly<{
	schemaVersion: 1;
	generatedAt: string;
	machine: Readonly<{
		nodeVersion: string;
		platform: string;
		arch: string;
		cpuModel: string;
		totalMemoryBytes: number;
	}>;
	corpus: Readonly<{
		id: string;
		sha256: string;
		typescriptProjectContexts: number;
		oracleProjectContexts: number;
		fileCount: number;
		symbolCount: number;
		editTargets: readonly Readonly<{adapterId: 'typescript' | 'oracle'; path: string}>[];
	}>;
	edit: Readonly<{
		rounds: number;
		debounceMs: number;
		samples: readonly MultiAdapterEditSampleType[];
		percentiles: Readonly<{
			count: number;
			p50Ms: number | null;
			p95Ms: number | null;
			p99Ms: number | null;
			maxMs: number | null;
		}>;
	}>;
	isolation: Readonly<{
		typescriptEdits: Readonly<{typescript: AdapterCountersType; oracle: AdapterCountersType}>;
		oracleEdits: Readonly<{typescript: AdapterCountersType; oracle: AdapterCountersType}>;
		rounds: readonly MultiAdapterIsolationRoundType[];
	}>;
	supersession: MultiAdapterSupersessionType;
	resources: Readonly<{
		processTreeRssPeakBytes: number;
		processTreeRssIdleBytes: number;
		rssPeakBytes: number;
	}>;
	storage: Readonly<{databaseBytes: number; walBytes: number; shmBytes: number}>;
	freshness: Readonly<{state: string; dirtyFileCount: number | null}>;
}>;

const EditSampleSchema = z.object({
	iteration: z.number().int().min(1),
	adapterId: z.enum(['typescript', 'oracle']),
	path: z.string().min(1),
	latencyMs: z.number().min(0),
	eventToPublicationMs: z.number().min(0),
	revision: z.number().int().min(0),
});

const DiscardedAttemptSchema = z.object({
	attempt: z.number().int().min(1),
	cause: z.enum(['adapter-change', 'project-wide', 'manual', 'unknown']),
	stage: z.enum(['probe', 'scan', 'extraction', 'publication', 'unknown']),
	adapterId: z.string().min(1).nullable(),
	durationMs: z.number().min(0),
});

const PercentilesSchema = z.object({
	count: z.number().int().min(0),
	p50Ms: z.number().min(0).nullable(),
	p95Ms: z.number().min(0).nullable(),
	p99Ms: z.number().min(0).nullable(),
	maxMs: z.number().min(0).nullable(),
});

const IsolationRoundSchema = z.object({
	iteration: z.number().int().min(1),
	sourceAdapterId: z.enum(['typescript', 'oracle']),
	typescript: AdapterCountersSchema,
	oracle: AdapterCountersSchema,
});

/**
 * Complete multi-adapter report required by the gate.
 *
 * Every measured value is required. A missing metric makes the report invalid
 * rather than silently reducing the gate's coverage.
 */
export const MultiAdapterReportSchema = z.object({
	schemaVersion: z.literal(1),
	generatedAt: z.string().min(1),
	machine: z.object({
		nodeVersion: z.string().min(1),
		platform: z.string().min(1),
		arch: z.string().min(1),
		cpuModel: z.string().min(1),
		totalMemoryBytes: z.number().int().positive(),
	}),
	corpus: z.object({
		id: z.string().min(1),
		sha256: z.string().regex(/^[0-9a-f]{64}$/u),
		typescriptProjectContexts: z.number().int().min(0),
		oracleProjectContexts: z.number().int().min(0),
		fileCount: z.number().int().min(0),
		symbolCount: z.number().int().min(0),
		editTargets: z.array(z.object({adapterId: z.enum(['typescript', 'oracle']), path: z.string().min(1)})).min(2),
	}),
	edit: z.object({
		rounds: z.number().int().min(1),
		debounceMs: z.number().int().min(0),
		samples: z.array(EditSampleSchema).min(1),
		percentiles: PercentilesSchema,
	}),
	isolation: z.object({
		typescriptEdits: z.object({typescript: AdapterCountersSchema, oracle: AdapterCountersSchema}),
		oracleEdits: z.object({typescript: AdapterCountersSchema, oracle: AdapterCountersSchema}),
		rounds: z.array(IsolationRoundSchema).min(1),
	}),
	supersession: z.object({
		startedAttempts: z.number().int().min(0),
		attempts: z.number().int().min(0),
		discarded: z.array(DiscardedAttemptSchema),
		discardedDurationMs: z.number().min(0),
		finalPublishedDurationMs: z.number().min(0),
	}),
	resources: z.object({
		processTreeRssPeakBytes: z.number().min(0),
		processTreeRssIdleBytes: z.number().min(0),
		rssPeakBytes: z.number().min(0),
	}),
	storage: z.object({
		databaseBytes: z.number().min(0),
		walBytes: z.number().min(0),
		shmBytes: z.number().min(0),
	}),
	freshness: z.object({state: z.string().min(1), dirtyFileCount: z.number().int().min(0).nullable()}),
});

/** Multi-adapter baseline: absolute gates only, machine-specific reference values are not used. */
export const MultiAdapterBaselineSchema = z
	.object({
		schemaVersion: z.literal(1),
		reportSchemaVersion: z.literal(1),
		corpus: z.object({
			id: z.string().min(1),
			sha256: z.string().regex(/^[0-9a-f]{64}$/u),
			typescriptProjectContexts: z.number().int().min(5),
			oracleProjectContexts: z.number().int().min(1),
		}),
		thresholds: z.object({
			editP95WarningMs: z.number().min(0),
			editP95FailureMs: z.number().min(0),
			minimumEditSamples: z.number().int().min(1),
			maxSupersededAttempts: z.number().int().min(0),
			maxSupersededDiscardedMs: z.number().min(0),
			processTreeRssWarningBytes: z.number().min(0),
			processTreeRssFailureBytes: z.number().min(0),
			idleProcessTreeRssWarningBytes: z.number().min(0),
			idleProcessTreeRssFailureBytes: z.number().min(0),
		}),
	})
	.superRefine((baseline, context) => {
		if (baseline.thresholds.editP95FailureMs < baseline.thresholds.editP95WarningMs) {
			context.addIssue({code: 'custom', path: ['thresholds', 'editP95FailureMs'], message: 'editP95FailureMs must be at least editP95WarningMs'});
		}

		if (baseline.thresholds.processTreeRssFailureBytes < baseline.thresholds.processTreeRssWarningBytes) {
			context.addIssue({
				code: 'custom',
				path: ['thresholds', 'processTreeRssFailureBytes'],
				message: 'processTreeRssFailureBytes must be at least processTreeRssWarningBytes',
			});
		}

		if (baseline.thresholds.idleProcessTreeRssFailureBytes < baseline.thresholds.idleProcessTreeRssWarningBytes) {
			context.addIssue({
				code: 'custom',
				path: ['thresholds', 'idleProcessTreeRssFailureBytes'],
				message: 'idleProcessTreeRssFailureBytes must be at least idleProcessTreeRssWarningBytes',
			});
		}
	});

export type MultiAdapterBaselineType = z.infer<typeof MultiAdapterBaselineSchema>;
