import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {type AnalyticsEventType, parseAnalyticsEvent} from './events.ts';

const {dirname, join} = path;

const EXACT_NAME_PRESENCE = new Set(['none', 'P', 'R', 'I', 'PR', 'PI', 'RI', 'PRI']);

export type AnalyticsSummaryType = Readonly<{
	readonly files: number;
	readonly events: number;
	readonly duplicates: number;
	readonly invalid: number;
	readonly since: string | null;
	readonly firstTimestamp: string | null;
	readonly lastTimestamp: string | null;
	readonly counts: Readonly<Record<string, number>>;
	readonly tools: Readonly<Record<string, ToolSummaryType>>;
	readonly exactNamePresence: Readonly<Record<string, number>>;
	readonly builds: Readonly<{
		readonly count: number;
		readonly p50Ms: number | null;
		readonly p95Ms: number | null;
		readonly stages: Readonly<Record<string, number | null>>;
		readonly failures: number;
	}>;
	readonly freshness: Readonly<Record<string, number>>;
	readonly watcher: Readonly<{
		readonly events: number;
		readonly refreshes: number;
		readonly coalesced: number;
		readonly eventToPublicationP95Ms: number | null;
	}>;
}>;

type ToolSummaryType = Readonly<{
	readonly calls: number;
	readonly errors: number;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
	readonly p99Ms: number | null;
	readonly bytes: number;
	readonly truncated: number;
}>;

export type CollectedAnalyticsEventsType = Readonly<{
	readonly files: number;
	readonly events: readonly AnalyticsEventType[];
	readonly duplicates: number;
	readonly invalid: number;
}>;

type ToolAccumulatorType = {
	readonly latency: number[];
	bytes: number;
	errors: number;
	truncated: number;
};

type AggregateStateType = {
	readonly counts: Record<string, number>;
	readonly freshness: Record<string, number>;
	readonly exactNamePresence: Record<string, number>;
	readonly tools: Map<string, ToolAccumulatorType>;
	readonly buildDurations: number[];
	readonly stageValues: Map<string, number[]>;
	readonly publicationDurations: number[];
	buildFailures: number;
	watcherEvents: number;
	watcherRefreshes: number;
	watcherCoalesced: number;
};

const parseSince = (value: string): number | null => {
	const match = /^(?<amount>\d+)(?<unit>[mhd])$/u.exec(value);

	if (match?.groups === undefined) {
		return null;
	}

	const {amount, unit} = match.groups;
	const amountNumber = Number(amount);

	if (unit === 'd') {
		return amountNumber * 24 * 60 * 60 * 1000;
	}

	return unit === 'h' ? amountNumber * 60 * 60 * 1000 : amountNumber * 60 * 1000;
};

const percentile = (values: readonly number[], fraction: number): number | null => {
	if (values.length === 0) {
		return null;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return Math.round(sorted[index] ?? 0);
};

const numberField = (event: AnalyticsEventType, key: string): number | null => {
	const value = event[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const stringField = (event: AnalyticsEventType, key: string): string | null => {
	const value = event[key];
	return typeof value === 'string' ? value : null;
};

const eventFiles = (analyticsPath: string): readonly string[] => {
	const directory = dirname(analyticsPath);

	if (!existsSync(directory)) {
		return [];
	}

	return readdirSync(directory)
		.filter((name) => name.endsWith('.jsonl'))
		.sort()
		.map((name) => join(directory, name));
};

const parseLines = (file: string, cutoff: number | null, seen: Set<string>, state: CollectedAnalyticsEventsType): CollectedAnalyticsEventsType => {
	const events: AnalyticsEventType[] = [...state.events];
	let {duplicates, invalid} = state;

	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (line.trim().length === 0) {
			continue;
		}

		let raw: unknown;

		try {
			raw = JSON.parse(line);
		} catch {
			invalid += 1;
			continue;
		}

		const event = parseAnalyticsEvent(raw);

		if (event === null) {
			invalid += 1;
			continue;
		}

		if (cutoff !== null && Date.parse(event.timestamp) < cutoff) {
			continue;
		}

		if (seen.has(event.id)) {
			duplicates += 1;
			continue;
		}

		seen.add(event.id);
		events.push(event);
	}

	return {files: state.files, events, duplicates, invalid};
};

export const collectAnalyticsEvents = (analyticsPath: string, since?: string): CollectedAnalyticsEventsType => {
	const files = eventFiles(analyticsPath);
	const sinceMs = since === undefined ? null : parseSince(since);
	const cutoff = sinceMs === null ? null : Date.now() - sinceMs;
	const seen = new Set<string>();
	let collected: CollectedAnalyticsEventsType = {files: files.length, events: [], duplicates: 0, invalid: 0};

	for (const file of files) {
		collected = parseLines(file, cutoff, seen, collected);
	}

	return collected;
};

const accumulateTool = (state: AggregateStateType, event: AnalyticsEventType): void => {
	const tool = stringField(event, 'tool') ?? 'unknown';
	const entry = state.tools.get(tool) ?? {latency: [], bytes: 0, errors: 0, truncated: 0};
	const duration = numberField(event, 'durationMs');

	if (duration !== null) {
		entry.latency.push(duration);
	}

	entry.bytes += numberField(event, 'bytes') ?? 0;
	entry.errors += event['ok'] === false ? 1 : 0;
	entry.truncated += event['truncated'] === true ? 1 : 0;
	state.tools.set(tool, entry);
	const freshness = stringField(event, 'freshness');

	if (freshness !== null) {
		state.freshness[freshness] = (state.freshness[freshness] ?? 0) + 1;
	}
};

const accumulateBuild = (state: AggregateStateType, event: AnalyticsEventType): void => {
	const duration = numberField(event, 'durationMs');

	if (duration !== null) {
		state.buildDurations.push(duration);
	}

	const {stages} = event;

	if (typeof stages !== 'object' || stages === null) {
		return;
	}

	for (const [stage, value] of Object.entries(stages)) {
		if (typeof value !== 'number') {
			continue;
		}

		const values = state.stageValues.get(stage) ?? [];
		values.push(value);
		state.stageValues.set(stage, values);
	}
};

const accumulateEvent = (state: AggregateStateType, event: AnalyticsEventType): void => {
	state.counts[event.event] = (state.counts[event.event] ?? 0) + 1;

	if (event.event === 'find_symbol_outcome') {
		const presence = stringField(event, 'presence');

		if (presence !== null && EXACT_NAME_PRESENCE.has(presence)) {
			state.exactNamePresence[presence] = (state.exactNamePresence[presence] ?? 0) + 1;
		}
	}

	if (event.event === 'mcp_tool_call') {
		accumulateTool(state, event);
		return;
	}

	if (event.event === 'build_complete' || event.event === 'build_reused') {
		accumulateBuild(state, event);
		return;
	}

	if (event.event === 'build_failed') {
		state.buildFailures += 1;
		return;
	}

	if (event.event === 'refresh_published') {
		state.watcherRefreshes += 1;
		const duration = numberField(event, 'eventToPublicationMs');

		if (duration !== null) {
			state.publicationDurations.push(duration);
		}
	}

	if (event.event.startsWith('watcher_') || event.event === 'refresh_published') {
		state.watcherEvents += 1;
	}

	if (event.event === 'refresh_coalesced') {
		state.watcherCoalesced += 1;
	}
};

const toolSummaries = (tools: ReadonlyMap<string, ToolAccumulatorType>): Readonly<Record<string, ToolSummaryType>> => {
	const summaries: Record<string, ToolSummaryType> = {};

	for (const [tool, entry] of tools) {
		summaries[tool] = {
			calls: entry.latency.length,
			errors: entry.errors,
			p50Ms: percentile(entry.latency, 0.5),
			p95Ms: percentile(entry.latency, 0.95),
			p99Ms: percentile(entry.latency, 0.99),
			bytes: entry.bytes,
			truncated: entry.truncated,
		};
	}

	return summaries;
};

const stageSummaries = (stages: ReadonlyMap<string, readonly number[]>): Readonly<Record<string, number | null>> => {
	const summaries: Record<string, number | null> = {};

	for (const [stage, values] of stages) {
		summaries[stage] = percentile(values, 0.5);
	}

	return summaries;
};

/**
 * Reads and aggregates versioned analytics without model calls.
 *
 * Invalid lines are counted and ignored. Duplicate event identifiers from an
 * interrupted append are counted and ignored.
 *
 * @param analyticsPath - Configured JSONL path.
 * @param since - Optional duration such as `24h`, `7d`, or `30m`.
 * @returns Aggregated counts, percentiles, freshness, builds, and watcher data.
 */
export const summarizeAnalytics = (analyticsPath: string, since?: string): AnalyticsSummaryType => {
	const collected = collectAnalyticsEvents(analyticsPath, since);
	const state: AggregateStateType = {
		counts: {},
		freshness: {},
		exactNamePresence: {},
		tools: new Map(),
		buildDurations: [],
		stageValues: new Map(),
		publicationDurations: [],
		buildFailures: 0,
		watcherEvents: 0,
		watcherRefreshes: 0,
		watcherCoalesced: 0,
	};

	for (const event of collected.events) {
		accumulateEvent(state, event);
	}

	const timestamps = collected.events.map((event) => event.timestamp).sort();

	return {
		files: collected.files,
		events: collected.events.length,
		duplicates: collected.duplicates,
		invalid: collected.invalid,
		since: since ?? null,
		firstTimestamp: timestamps.at(0) ?? null,
		lastTimestamp: timestamps.at(-1) ?? null,
		counts: state.counts,
		tools: toolSummaries(state.tools),
		exactNamePresence: state.exactNamePresence,
		builds: {
			count: state.buildDurations.length,
			p50Ms: percentile(state.buildDurations, 0.5),
			p95Ms: percentile(state.buildDurations, 0.95),
			stages: stageSummaries(state.stageValues),
			failures: state.buildFailures,
		},
		freshness: state.freshness,
		watcher: {
			events: state.watcherEvents,
			refreshes: state.watcherRefreshes,
			coalesced: state.watcherCoalesced,
			eventToPublicationP95Ms: percentile(state.publicationDurations, 0.95),
		},
	};
};

const formatValue = (value: number | null): string => (value === null ? '-' : String(value));

const toolLines = (tools: Readonly<Record<string, ToolSummaryType>>): readonly string[] =>
	Object.entries(tools)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([tool, entry]) =>
				`  ${tool}: calls ${entry.calls}, errors ${entry.errors}, p50 ${formatValue(entry.p50Ms)} ms, p95 ${formatValue(entry.p95Ms)} ms, p99 ${formatValue(entry.p99Ms)} ms, bytes ${entry.bytes}`,
		);

export const formatAnalyticsText = (summary: AnalyticsSummaryType): readonly string[] => [
	`events: ${summary.events} (${summary.files} file(s), ${summary.invalid} invalid, ${summary.duplicates} duplicate)`,
	`window: ${summary.since ?? 'all'} (${summary.firstTimestamp ?? '-'} .. ${summary.lastTimestamp ?? '-'})`,
	'',
	'events:',
	...Object.keys(summary.counts)
		.sort()
		.map((event) => `  ${event}: ${summary.counts[event] ?? 0}`),
	'',
	'tools:',
	...toolLines(summary.tools),
	'',
	`find_symbol exact-name presence: ${JSON.stringify(summary.exactNamePresence)}`,
	'',
	`builds: ${summary.builds.count}, failures ${summary.builds.failures}, p50 ${formatValue(summary.builds.p50Ms)} ms, p95 ${formatValue(summary.builds.p95Ms)} ms`,
	...Object.entries(summary.builds.stages).map(([stage, value]) => `  ${stage}: ${formatValue(value)} ms`),
	'',
	`freshness: ${JSON.stringify(summary.freshness)}`,
	`watcher: events ${summary.watcher.events}, refreshes ${summary.watcher.refreshes}, coalesced ${summary.watcher.coalesced}, event-to-publication p95 ${formatValue(summary.watcher.eventToPublicationP95Ms)} ms`,
];

const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const tableRows = (tools: Readonly<Record<string, ToolSummaryType>>): string =>
	Object.entries(tools)
		.map(
			([tool, entry]) =>
				`<tr><td>${escapeHtml(tool)}</td><td>${entry.calls}</td><td>${entry.errors}</td><td>${formatValue(entry.p50Ms)}</td><td>${formatValue(entry.p95Ms)}</td><td>${formatValue(entry.p99Ms)}</td><td>${entry.bytes}</td></tr>`,
		)
		.join('');

export const formatAnalyticsHtml = (summary: AnalyticsSummaryType): string => {
	const details = JSON.stringify(
		{stages: summary.builds.stages, freshness: summary.freshness, watcher: summary.watcher, exactNamePresence: summary.exactNamePresence},
		null,
		2,
	);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Code index analytics</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 2rem; }
table { border-collapse: collapse; margin-block: 1rem; }
th, td { border: 1px solid currentColor; padding: 0.35rem 0.6rem; text-align: right; }
th:first-child, td:first-child { text-align: left; }
code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<h1>Code index analytics</h1>
<p><code>${escapeHtml(summary.firstTimestamp ?? '-')}</code> to <code>${escapeHtml(summary.lastTimestamp ?? '-')}</code>; ${summary.events} events.</p>
<h2>Tools</h2>
<table><thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Bytes</th></tr></thead><tbody>${tableRows(summary.tools)}</tbody></table>
<h2>Builds</h2>
<p>${summary.builds.count} builds, ${summary.builds.failures} failures, p50 ${formatValue(summary.builds.p50Ms)} ms, p95 ${formatValue(summary.builds.p95Ms)} ms.</p>
<pre>${escapeHtml(details)}</pre>
</body>
</html>
`;
};
