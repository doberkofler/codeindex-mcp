import {z} from 'zod';
import {type AnalyticsDashboardType, type AnalyticsWindowType} from '../../core/analytics/contracts.ts';
import {type IndexStatusType} from '../../core/model.ts';

export const CONSOLE_OPERATIONS = ['update', 'rebuild', 'verify', 'benchmark', 'qualify', 'mcp-install'] as const;

export type ConsoleOperationType = (typeof CONSOLE_OPERATIONS)[number];

export type ConsoleJobStateType = 'queued' | 'running' | 'succeeded' | 'failed';

export type ConsoleJobType = Readonly<{
	readonly id: string;
	readonly operation: ConsoleOperationType;
	readonly state: ConsoleJobStateType;
	readonly createdAt: string;
	readonly startedAt: string | null;
	readonly completedAt: string | null;
	readonly durationMs: number | null;
	readonly message: string | null;
	readonly result: unknown;
}>;

export type ConsoleMetaType = Readonly<{
	readonly program: string;
	readonly version: string;
	readonly nodeVersion: string;
	readonly schemaVersion: string;
	readonly projectName: string;
	readonly rootDir: string;
	readonly projectFilePath: string;
	readonly extractorId: string;
	readonly extractorVersion: string;
	readonly databasePath: string;
	readonly analyticsPath: string;
	readonly analyticsEnabled: boolean;
	readonly projectId: string;
	readonly maxResultBytes: number;
	readonly maxReadLines: number;
	readonly logLevel: string;
	readonly loopbackOnly: boolean;
	readonly tokenRequired: boolean;
	readonly operations: readonly ConsoleOperationType[];
}>;

export type {AnalyticsDashboardType, AnalyticsToolType, AnalyticsWindowType} from '../../core/analytics/contracts.ts';

export type ConsoleSnapshotType = Readonly<{
	readonly meta: ConsoleMetaType;
	readonly status: IndexStatusType;
	readonly jobs: readonly ConsoleJobType[];
}>;

const operationSchema = z.enum(CONSOLE_OPERATIONS);
const jobStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);

const consoleJobSchema = z.object({
	id: z.string(),
	operation: operationSchema,
	state: jobStateSchema,
	createdAt: z.string(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	durationMs: z.number().nullable(),
	message: z.string().nullable(),
	result: z.unknown(),
}) satisfies z.ZodType<ConsoleJobType>;

const consoleMetaSchema = z.object({
	program: z.string(),
	version: z.string(),
	nodeVersion: z.string(),
	schemaVersion: z.string(),
	projectName: z.string(),
	rootDir: z.string(),
	projectFilePath: z.string(),
	extractorId: z.string(),
	extractorVersion: z.string(),
	databasePath: z.string(),
	analyticsPath: z.string(),
	analyticsEnabled: z.boolean(),
	projectId: z.string(),
	maxResultBytes: z.number(),
	maxReadLines: z.number(),
	logLevel: z.string(),
	loopbackOnly: z.boolean(),
	tokenRequired: z.boolean(),
	operations: z.array(operationSchema),
}) satisfies z.ZodType<ConsoleMetaType>;

const buildStagesSchema = z.object({
	scanMs: z.number(),
	compilerMs: z.number(),
	extractionMs: z.number(),
	insertionMs: z.number(),
	verificationMs: z.number(),
	publicationMs: z.number(),
});

const buildLeaseSchema = z.object({
	projectId: z.string(),
	ownerId: z.string(),
	processId: z.number(),
	acquiredAt: z.string(),
	heartbeatAt: z.string(),
	expiresAt: z.string(),
});

const indexStatusSchema = z.object({
	ready: z.boolean(),
	state: z.enum(['building', 'published', 'superseded', 'failed', 'absent']),
	refresh: z.enum(['current', 'dirty', 'building', 'failed', 'unknown', 'stopping']),
	generationId: z.string().nullable(),
	building: z.boolean(),
	scope: z.object({
		root: z.string(),
		projectName: z.string(),
		projectFile: z.string(),
		projects: z.array(z.object({name: z.string(), projectFile: z.string()})),
		extractor: z.object({id: z.string(), version: z.string(), compilerVersion: z.string()}),
		projectId: z.string(),
		workingCopyId: z.string().nullable(),
	}),
	hashes: z.object({source: z.string().nullable(), configuration: z.string().nullable()}),
	counts: z.object({
		files: z.number(),
		symbols: z.number(),
		occurrences: z.number(),
		dependencyEdges: z.number(),
		dependencyBindings: z.number(),
		diagnostics: z.number(),
	}),
	build: z.object({
		startedAt: z.string().nullable(),
		completedAt: z.string().nullable(),
		durationMs: z.number().nullable(),
		stages: buildStagesSchema.nullable(),
	}),
	freshness: z.object({
		state: z.enum(['current', 'updating', 'stale', 'unknown']),
		checkedAt: z.string(),
		dirtyFileCount: z.number().nullable(),
		staleFiles: z.number(),
		sourceChanged: z.boolean().nullable(),
	}),
	lease: buildLeaseSchema.nullable(),
	exclusions: z.array(z.string()),
	lastError: z.string().nullable(),
}) satisfies z.ZodType<IndexStatusType>;

export const consoleSnapshotSchema = z.object({
	meta: consoleMetaSchema,
	status: indexStatusSchema,
	jobs: z.array(consoleJobSchema),
}) satisfies z.ZodType<ConsoleSnapshotType>;

const analyticsTimelinePointSchema = z.object({
	bucketStart: z.string(),
	events: z.number(),
	toolCalls: z.number(),
	errors: z.number(),
	builds: z.number(),
	refreshes: z.number(),
});

const analyticsLatencyBucketSchema = z.object({
	label: z.string(),
	upperMs: z.number().nullable(),
	count: z.number(),
});

const analyticsToolSchema = z.object({
	name: z.string(),
	calls: z.number(),
	errors: z.number(),
	errorRate: z.number(),
	p50Ms: z.number().nullable(),
	p95Ms: z.number().nullable(),
	p99Ms: z.number().nullable(),
	bytes: z.number(),
	truncated: z.number(),
	latencyBuckets: z.array(analyticsLatencyBucketSchema),
	timeline: z.array(z.object({bucketStart: z.string(), calls: z.number(), errors: z.number()})),
});

const analyticsWindowSchema = z.enum(['1h', '24h', '7d', '30d', 'all']) satisfies z.ZodType<AnalyticsWindowType>;

export const analyticsDashboardSchema = z.object({
	generatedAt: z.string(),
	window: z.object({
		since: analyticsWindowSchema,
		firstTimestamp: z.string().nullable(),
		lastTimestamp: z.string().nullable(),
		events: z.number(),
		files: z.number(),
		invalid: z.number(),
		duplicates: z.number(),
		bucketMs: z.number(),
	}),
	totals: z.object({
		toolCalls: z.number(),
		errors: z.number(),
		errorRate: z.number(),
		builds: z.number(),
		buildFailures: z.number(),
		refreshes: z.number(),
		coalesced: z.number(),
		bytes: z.number(),
		truncated: z.number(),
	}),
	timeline: z.array(analyticsTimelinePointSchema),
	tools: z.array(analyticsToolSchema),
	builds: z.object({
		count: z.number(),
		failures: z.number(),
		p50Ms: z.number().nullable(),
		p95Ms: z.number().nullable(),
		stages: z.array(z.object({stage: z.string(), p50Ms: z.number().nullable(), p95Ms: z.number().nullable()})),
		timeline: z.array(z.object({bucketStart: z.string(), timestamp: z.string(), durationMs: z.number(), outcome: z.enum(['complete', 'reused', 'failed'])})),
	}),
	freshness: z.array(z.object({state: z.string(), count: z.number()})),
	watcher: z.object({
		events: z.number(),
		refreshes: z.number(),
		coalesced: z.number(),
		eventToPublicationP95Ms: z.number().nullable(),
		timeline: z.array(analyticsTimelinePointSchema),
	}),
}) satisfies z.ZodType<AnalyticsDashboardType>;

export const consoleJobResponseSchema = z.object({job: consoleJobSchema}) satisfies z.ZodType<Readonly<{job: ConsoleJobType}>>;
