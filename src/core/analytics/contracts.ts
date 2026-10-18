/**
 * Shared analytics wire contracts.
 *
 * These types describe derived analytics aggregates. They live in the core so
 * analytics code does not depend on a transport, and every transport or UI can
 * import the same shape.
 */

export type AnalyticsWindowType = '1h' | '24h' | '7d' | '30d' | 'all';

export type AnalyticsTimelinePointType = Readonly<{
	readonly bucketStart: string;
	readonly events: number;
	readonly toolCalls: number;
	readonly errors: number;
	readonly builds: number;
	readonly refreshes: number;
}>;

type AnalyticsToolTimelinePointType = Readonly<{
	readonly bucketStart: string;
	readonly calls: number;
	readonly errors: number;
}>;

export type AnalyticsLatencyBucketType = Readonly<{
	readonly label: string;
	readonly upperMs: number | null;
	readonly count: number;
}>;

export type AnalyticsToolType = Readonly<{
	readonly name: string;
	readonly calls: number;
	readonly errors: number;
	readonly errorRate: number;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
	readonly p99Ms: number | null;
	readonly bytes: number;
	readonly truncated: number;
	readonly latencyBuckets: readonly AnalyticsLatencyBucketType[];
	readonly timeline: readonly AnalyticsToolTimelinePointType[];
}>;

export type AnalyticsBuildPointType = Readonly<{
	readonly bucketStart: string;
	readonly timestamp: string;
	readonly durationMs: number;
	readonly outcome: 'complete' | 'reused' | 'failed';
}>;

export type AnalyticsStageType = Readonly<{
	readonly stage: string;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
}>;

export type AnalyticsDashboardType = Readonly<{
	readonly generatedAt: string;
	readonly window: Readonly<{
		readonly since: AnalyticsWindowType;
		readonly firstTimestamp: string | null;
		readonly lastTimestamp: string | null;
		readonly events: number;
		readonly files: number;
		readonly invalid: number;
		readonly duplicates: number;
		readonly bucketMs: number;
	}>;
	readonly totals: Readonly<{
		readonly toolCalls: number;
		readonly errors: number;
		readonly errorRate: number;
		readonly builds: number;
		readonly buildFailures: number;
		readonly refreshes: number;
		readonly coalesced: number;
		readonly bytes: number;
		readonly truncated: number;
	}>;
	readonly timeline: readonly AnalyticsTimelinePointType[];
	readonly tools: readonly AnalyticsToolType[];
	readonly builds: Readonly<{
		readonly count: number;
		readonly failures: number;
		readonly p50Ms: number | null;
		readonly p95Ms: number | null;
		readonly stages: readonly AnalyticsStageType[];
		readonly timeline: readonly AnalyticsBuildPointType[];
	}>;
	readonly freshness: readonly Readonly<{state: string; count: number}>[];
	readonly watcher: Readonly<{
		readonly events: number;
		readonly refreshes: number;
		readonly coalesced: number;
		readonly eventToPublicationP95Ms: number | null;
		readonly timeline: readonly AnalyticsTimelinePointType[];
	}>;
}>;
