import {
	type AnalyticsBuildPointType,
	type AnalyticsDashboardType,
	type AnalyticsLatencyBucketType,
	type AnalyticsStageType,
	type AnalyticsTimelinePointType,
	type AnalyticsToolType,
	type AnalyticsWindowType,
} from './contracts.ts';
import {type AnalyticsEventType} from './events.ts';
import {collectAnalyticsEvents} from './report.ts';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_BUCKETS = 120;
const LATENCY_BUCKETS: readonly (readonly [string, number | null])[] = [
	['≤5 ms', 5],
	['≤10 ms', 10],
	['≤25 ms', 25],
	['≤50 ms', 50],
	['≤100 ms', 100],
	['≤250 ms', 250],
	['≤500 ms', 500],
	['≤1 s', 1000],
	['≤2.5 s', 2500],
	['≤5 s', 5000],
	['≤10 s', 10_000],
	['>10 s', null],
];

type BucketAccumulatorType = {
	events: number;
	toolCalls: number;
	errors: number;
	builds: number;
	refreshes: number;
};

type ToolAccumulatorType = {
	readonly latency: number[];
	readonly buckets: Map<string, {calls: number; errors: number}>;
	bytes: number;
	errors: number;
	truncated: number;
};

type BuildAccumulatorType = {
	readonly durations: number[];
	readonly stageValues: Map<string, number[]>;
	readonly timeline: AnalyticsBuildPointType[];
	failures: number;
};

const numberField = (event: AnalyticsEventType, key: string): number | null => {
	const value = event[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const stringField = (event: AnalyticsEventType, key: string): string | null => {
	const value = event[key];
	return typeof value === 'string' ? value : null;
};

const percentile = (values: readonly number[], fraction: number): number | null => {
	if (values.length === 0) {
		return null;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));

	return Math.round(sorted[index] ?? 0);
};

const rate = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);

const bucketDuration = (spanMs: number): number => {
	const candidates = [5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS, DAY_MS];
	return candidates.find((candidate) => spanMs / candidate <= MAX_BUCKETS) ?? DAY_MS;
};

const bucketStart = (timestamp: string, durationMs: number): string => {
	const parsed = Date.parse(timestamp);
	return new Date(Math.floor(parsed / durationMs) * durationMs).toISOString();
};

const emptyBucket = (): BucketAccumulatorType => ({events: 0, toolCalls: 0, errors: 0, builds: 0, refreshes: 0});

const bucketOf = (buckets: Map<string, BucketAccumulatorType>, key: string): BucketAccumulatorType => {
	const bucket = buckets.get(key) ?? emptyBucket();
	buckets.set(key, bucket);
	return bucket;
};

const timelineOf = (buckets: ReadonlyMap<string, BucketAccumulatorType>): readonly AnalyticsTimelinePointType[] =>
	[...buckets.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, bucket]) => ({
			bucketStart: key,
			events: bucket.events,
			toolCalls: bucket.toolCalls,
			errors: bucket.errors,
			builds: bucket.builds,
			refreshes: bucket.refreshes,
		}));

const latencyBuckets = (values: readonly number[]): readonly AnalyticsLatencyBucketType[] => {
	const counts = LATENCY_BUCKETS.map(() => 0);

	for (const value of values) {
		const index = LATENCY_BUCKETS.findIndex(([, upper]) => upper !== null && value <= upper);
		const resolved = index === -1 ? LATENCY_BUCKETS.length - 1 : index;
		counts[resolved] = (counts[resolved] ?? 0) + 1;
	}

	return LATENCY_BUCKETS.map(([label, upperMs], index) => ({label, upperMs, count: counts[index] ?? 0}));
};

const toolSummaries = (tools: ReadonlyMap<string, ToolAccumulatorType>): readonly AnalyticsToolType[] =>
	[...tools.entries()]
		.map(([name, tool]) => ({
			name,
			calls: tool.latency.length,
			errors: tool.errors,
			errorRate: rate(tool.errors, tool.latency.length),
			p50Ms: percentile(tool.latency, 0.5),
			p95Ms: percentile(tool.latency, 0.95),
			p99Ms: percentile(tool.latency, 0.99),
			bytes: tool.bytes,
			truncated: tool.truncated,
			latencyBuckets: latencyBuckets(tool.latency),
			timeline: [...tool.buckets.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => ({bucketStart: key, calls: entry.calls, errors: entry.errors})),
		}))
		.sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));

const stageSummaries = (stages: ReadonlyMap<string, readonly number[]>): readonly AnalyticsStageType[] =>
	[...stages.entries()]
		.map(([stage, values]) => ({stage, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95)}))
		.sort((left, right) => (right.p50Ms ?? 0) - (left.p50Ms ?? 0));

const toolOf = (tools: Map<string, ToolAccumulatorType>, name: string): ToolAccumulatorType => {
	const tool = tools.get(name) ?? {latency: [], buckets: new Map(), bytes: 0, errors: 0, truncated: 0};
	tools.set(name, tool);
	return tool;
};

const accumulateTool = (
	input: Readonly<{event: AnalyticsEventType; durationMs: number; bucket: string; tools: Map<string, ToolAccumulatorType>; bucketState: BucketAccumulatorType}>,
): void => {
	const name = stringField(input.event, 'tool') ?? 'unknown';
	const tool = toolOf(input.tools, name);
	const failed = input.event['ok'] === false;
	tool.latency.push(input.durationMs);
	tool.bytes += numberField(input.event, 'bytes') ?? 0;
	tool.errors += failed ? 1 : 0;
	tool.truncated += input.event['truncated'] === true ? 1 : 0;
	const toolBucket = tool.buckets.get(input.bucket) ?? {calls: 0, errors: 0};
	toolBucket.calls += 1;
	toolBucket.errors += failed ? 1 : 0;
	tool.buckets.set(input.bucket, toolBucket);
	input.bucketState.toolCalls += 1;
	input.bucketState.errors += failed ? 1 : 0;
};

const accumulateBuild = (
	input: Readonly<{
		event: AnalyticsEventType;
		durationMs: number;
		bucket: string;
		builds: BuildAccumulatorType;
		bucketState: BucketAccumulatorType;
	}>,
): void => {
	const outcome = input.event.event === 'build_failed' ? 'failed' : input.event.event === 'build_reused' ? 'reused' : 'complete';
	input.builds.durations.push(input.durationMs);
	input.builds.failures += outcome === 'failed' ? 1 : 0;
	input.builds.timeline.push({bucketStart: input.bucket, timestamp: input.event.timestamp, durationMs: input.durationMs, outcome});
	input.bucketState.builds += 1;
	input.bucketState.errors += outcome === 'failed' ? 1 : 0;
	const {stages} = input.event;

	if (typeof stages === 'object' && stages !== null) {
		for (const [stage, value] of Object.entries(stages)) {
			if (typeof value !== 'number') {
				continue;
			}

			const values = input.builds.stageValues.get(stage) ?? [];
			values.push(value);
			input.builds.stageValues.set(stage, values);
		}
	}
};

const buildTimeline = (timeline: readonly AnalyticsBuildPointType[]): readonly AnalyticsBuildPointType[] =>
	timeline.length <= 100 ? timeline : timeline.slice(-100);

type DashboardStateType = {
	readonly buckets: Map<string, BucketAccumulatorType>;
	readonly tools: Map<string, ToolAccumulatorType>;
	readonly builds: BuildAccumulatorType;
	readonly freshness: Map<string, number>;
	readonly publicationDurations: number[];
	refreshes: number;
	coalesced: number;
};

const accumulateDashboardEvent = (state: DashboardStateType, event: AnalyticsEventType, durationMs: number): void => {
	const key = bucketStart(event.timestamp, durationMs);
	const bucket = bucketOf(state.buckets, key);
	bucket.events += 1;
	const duration = numberField(event, 'durationMs');

	if (event.event === 'mcp_tool_call' && duration !== null) {
		accumulateTool({event, durationMs: duration, bucket: key, tools: state.tools, bucketState: bucket});
		const freshness = stringField(event, 'freshness');

		if (freshness !== null) {
			state.freshness.set(freshness, (state.freshness.get(freshness) ?? 0) + 1);
		}
	}

	if ((event.event === 'build_complete' || event.event === 'build_reused' || event.event === 'build_failed') && duration !== null) {
		accumulateBuild({event, durationMs: duration, bucket: key, builds: state.builds, bucketState: bucket});
	}

	if (event.event === 'refresh_published') {
		state.refreshes += 1;
		bucket.refreshes += 1;
		const publication = numberField(event, 'eventToPublicationMs');

		if (publication !== null) {
			state.publicationDurations.push(publication);
		}
	}

	if (event.event === 'refresh_coalesced') {
		state.coalesced += 1;
	}
};

/**
 * Aggregates privacy-safe analytics into dashboard series.
 *
 * Only counts, rates, percentiles, and bounded buckets leave this module; the
 * retained events themselves remain server-side.
 *
 * @param analyticsPath - Configured analytics JSONL path.
 * @param window - Requested dashboard window.
 * @returns Aggregate totals, timelines, tool details, builds, and freshness.
 */
export const buildAnalyticsDashboard = (analyticsPath: string, window: AnalyticsWindowType): AnalyticsDashboardType => {
	const collected = collectAnalyticsEvents(analyticsPath, window === 'all' ? undefined : window);
	const events = [...collected.events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
	const firstTimestamp = events.at(0)?.timestamp ?? null;
	const lastTimestamp = events.at(-1)?.timestamp ?? null;
	const spanMs = firstTimestamp === null || lastTimestamp === null ? HOUR_MS : Math.max(HOUR_MS, Date.parse(lastTimestamp) - Date.parse(firstTimestamp));
	const durationMs = bucketDuration(spanMs);
	const state: DashboardStateType = {
		buckets: new Map(),
		tools: new Map(),
		builds: {durations: [], stageValues: new Map(), timeline: [], failures: 0},
		freshness: new Map(),
		publicationDurations: [],
		refreshes: 0,
		coalesced: 0,
	};

	for (const event of events) {
		accumulateDashboardEvent(state, event, durationMs);
	}

	const {buckets, tools, builds, freshness, refreshes, coalesced, publicationDurations} = state;
	const toolValues = [...tools.values()];
	const totalToolCalls = toolValues.reduce((total, tool) => total + tool.latency.length, 0);
	const totalErrors = toolValues.reduce((total, tool) => total + tool.errors, 0);

	return {
		generatedAt: new Date().toISOString(),
		window: {
			since: window,
			firstTimestamp,
			lastTimestamp,
			events: events.length,
			files: collected.files,
			invalid: collected.invalid,
			duplicates: collected.duplicates,
			bucketMs: durationMs,
		},
		totals: {
			toolCalls: totalToolCalls,
			errors: totalErrors,
			errorRate: rate(totalErrors, totalToolCalls),
			builds: builds.durations.length,
			buildFailures: builds.failures,
			refreshes,
			coalesced,
			bytes: toolValues.reduce((total, tool) => total + tool.bytes, 0),
			truncated: toolValues.reduce((total, tool) => total + tool.truncated, 0),
		},
		timeline: timelineOf(buckets),
		tools: toolSummaries(tools),
		builds: {
			count: builds.durations.length,
			failures: builds.failures,
			p50Ms: percentile(builds.durations, 0.5),
			p95Ms: percentile(builds.durations, 0.95),
			stages: stageSummaries(builds.stageValues),
			timeline: buildTimeline(builds.timeline),
		},
		freshness: [...freshness.entries()].map(([stateName, count]) => ({state: stateName, count})).sort((left, right) => right.count - left.count),
		watcher: {
			events: events.filter((event) => event.event.startsWith('watcher_') || event.event === 'refresh_published').length,
			refreshes,
			coalesced,
			eventToPublicationP95Ms: percentile(publicationDurations, 0.95),
			timeline: timelineOf(buckets),
		},
	};
};
