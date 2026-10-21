/** Tool families used for retrieval-payload metrics. */
export const TOOL_FAMILIES = ['index', 'search', 'read', 'list', 'write', 'execute', 'task', 'other'] as const;

export type ToolFamilyType = (typeof TOOL_FAMILIES)[number];

/** Tool lifecycle states accepted from the OpenCode event stream. */
export const TOOL_STATUSES = ['pending', 'running', 'completed', 'error', 'unknown'] as const;

export type ToolStatusType = (typeof TOOL_STATUSES)[number];

/** Availability of one telemetry value. */
export type TelemetryStateType = 'exact' | 'unavailable' | 'not-applicable';

/** One telemetry entry; the value is null unless the state is `exact`. */
export type TelemetryEntryType = Readonly<{
	value: number | null;
	state: TelemetryStateType;
	unit: 'tokens' | 'usd';
	source: string;
}>;

/** Required token and cost metrics for one execution. */
export type TelemetryType = Readonly<{
	inputTokens: TelemetryEntryType;
	outputTokens: TelemetryEntryType;
	reasoningTokens: TelemetryEntryType;
	cacheReadTokens: TelemetryEntryType;
	cacheWriteTokens: TelemetryEntryType;
	reportedCost: TelemetryEntryType;
}>;

/** One normalized tool invocation. */
export type ToolCallType = Readonly<{
	/** One-based position in the normalized call sequence. */
	index: number;
	/** One-based raw event line that produced this call. */
	rawIndex: number;
	/** Position of the enclosing call when the part is nested, else null. */
	parentIndex: number | null;
	/** Stable provider call identifier when the event carries one. */
	id: string | null;
	tool: string;
	family: ToolFamilyType;
	status: ToolStatusType;
	/** Validated input object, or null when the event carried no input object. */
	input: Readonly<Record<string, unknown>> | null;
	/** True when the event carried a well-formed input object. */
	inputValid: boolean;
	/** Serialized tool input, truncated, used to detect code-mode index calls. */
	inputText: string;
	/** UTF-8 bytes of the tool output or error text. */
	outputBytes: number;
	/**
	 * Explicit authority marker from the response guidance, or null when the
	 * response carried none (including every pre-guidance artifact).
	 */
	authoritative: boolean | null;
	/** Duration reported by the tool part, or null when it was not reported. */
	durationMs: number | null;
	/** Error text when the tool failed, else null. */
	error: string | null;
}>;

/** One ordered, normalized agent event. Raw line numbers keep it auditable. */
export type AgentEventType =
	| Readonly<{index: number; rawIndex: number; type: 'text'; timestamp: number | null; text: string}>
	| Readonly<{index: number; rawIndex: number; type: 'tool'; timestamp: number | null; callIndex: number; tool: string; status: ToolStatusType}>
	| Readonly<{index: number; rawIndex: number; type: 'step_start'; timestamp: number | null}>
	| Readonly<{index: number; rawIndex: number; type: 'step_finish'; timestamp: number | null}>
	| Readonly<{index: number; rawIndex: number; type: 'error'; timestamp: number | null; message: string}>
	| Readonly<{index: number; rawIndex: number; type: 'other'; timestamp: number | null; rawType: string}>;

/** A line that could not be parsed as an event, retained for diagnosis. */
export type MalformedEventType = Readonly<{
	/** One-based raw line number. */
	line: number;
	reason: string;
	/** Bounded raw text; the full stream remains in the raw artifact. */
	text: string;
}>;

/** Token accounting kept for result compatibility. */
export type UsageType = Readonly<{
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** False when the client emitted no usable step_finish usage. */
	available: boolean;
}>;

/** Everything the harness derives from one agent event stream. */
export type RunEventsType = Readonly<{
	/** Normalized calls in stream order, including nested, unknown, and failed calls. */
	toolCalls: readonly ToolCallType[];
	/** Normalized event sequence without malformed lines. */
	events: readonly AgentEventType[];
	/** Lines that were not valid JSON events. */
	malformed: readonly MalformedEventType[];
	/** True when the final non-empty line was truncated or otherwise malformed. */
	truncated: boolean;
	/** Number of non-empty raw lines examined. */
	rawEventCount: number;
	/** Number of recognized step_finish events. */
	steps: number;
	finalText: string;
	telemetry: TelemetryType;
	usage: UsageType;
	/** Root-level error messages, one per emitted error event. */
	errors: readonly string[];
	/** Summed UTF-8 bytes returned by every tool call. */
	outputBytes: number;
	/** Summed UTF-8 output bytes per tool family. */
	familyBytes: Readonly<Record<ToolFamilyType, number>>;
}>;

export type ParseEventsOptionsType = Readonly<{
	/**
	 * Marks token telemetry as structurally absent for a model-free execution.
	 * Without it, a missing step_finish usage is `unavailable`, never estimated.
	 */
	modelFree?: boolean;
}>;

/** Provider-side rate limiting, matched across stdout, stderr, and events. */
const RATE_LIMIT_PATTERN = /rate.?limit|quota.?exceed|too many requests|\b429\b/i;

const MAX_ERROR_TEXT = 500;
const MAX_MALFORMED_TEXT = 500;
const MAX_INPUT_TEXT = 2_000;
const MAX_NESTING_DEPTH = 4;

const NESTED_KEYS = ['part', 'parts', 'properties', 'toolCalls', 'tool_calls', 'calls'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const recordAt = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const stringAt = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const numberAt = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

const timestampAt = (event: Record<string, unknown>, part: Record<string, unknown>): number | null =>
	numberAt(event['timestamp']) ?? numberAt(part['timestamp']);

/**
 * Reports whether any captured channel shows provider rate limiting.
 *
 * @param channels - Raw stdout, raw stderr, and parsed error messages.
 * @returns True when the execution was throttled rather than wrong.
 */
export const isRateLimited = (...channels: readonly string[]): boolean => channels.some((channel) => RATE_LIMIT_PATTERN.test(channel));

/**
 * Extracts the message of a root-level error or session error event.
 *
 * `opencode run --format json` emits `{"type":"error","error":{...}}` with no
 * `part` object, so the diagnostic lives on the event, not on a part.
 *
 * @param event - Parsed event record.
 * @returns A bounded, human-readable message.
 */
const errorMessageOf = (event: Record<string, unknown>): string => {
	const properties = recordAt(event['properties']);
	const candidate = isRecord(event['error']) ? event['error'] : recordAt(properties['error']);
	const data = recordAt(candidate['data']);
	const message =
		stringAt(candidate['message']) ?? stringAt(data['message']) ?? stringAt(candidate['name']) ?? stringAt(event['message']) ?? stringAt(properties['message']);

	if (message !== null) {
		return message.slice(0, MAX_ERROR_TEXT);
	}

	return JSON.stringify(event).slice(0, MAX_ERROR_TEXT);
};

const partOf = (event: Record<string, unknown>): Record<string, unknown> => {
	const direct = recordAt(event['part']);

	if (Object.keys(direct).length > 0) {
		return direct;
	}

	const properties = recordAt(event['properties']);
	const nested = recordAt(properties['part']);

	return Object.keys(nested).length > 0 ? nested : properties;
};

const isToolPart = (value: unknown): value is Record<string, unknown> =>
	isRecord(value) && typeof value['tool'] === 'string' && (value['type'] === 'tool' || isRecord(value['state']) || typeof value['callID'] === 'string');

/**
 * Classifies one tool name into a retrieval family.
 *
 * Classification is structural: CodeIndex tools keep their native server
 * prefix, while ordinary tools are matched by their exact documented name.
 *
 * @param tool - Exact tool name observed in the event stream.
 * @returns The family used by payload metrics.
 */
export const toolFamilyOf = (tool: string): ToolFamilyType => {
	const name = tool.toLowerCase();

	if (name.startsWith('codeindex_')) {
		return 'index';
	}

	if (name === 'grep' || name === 'glob' || name === 'codesearch' || name === 'websearch' || name === 'search') {
		return 'search';
	}

	if (name === 'read') {
		return 'read';
	}

	if (name === 'list') {
		return 'list';
	}

	if (name === 'write' || name === 'edit') {
		return 'write';
	}

	if (name === 'execute' || name === 'bash') {
		return 'execute';
	}

	if (name === 'task') {
		return 'task';
	}

	return 'other';
};

type CollectedPartType = Readonly<{part: Record<string, unknown>; parentIndex: number | null}>;

/**
 * Collects every tool part nested in one event without interpreting tool
 * inputs or outputs as events.
 *
 * Both the flat `{type: "tool_use", part}` envelope and the raw server
 * envelope `{type: "message.part.updated", properties: {part}}` are admitted.
 * A tool part that contains child `parts` contributes its own ordered children.
 *
 * @param event - One parsed event record.
 * @returns Tool parts in encounter order with their parent call position.
 */
const toolPartsOf = (event: Record<string, unknown>): readonly CollectedPartType[] => {
	const collected: CollectedPartType[] = [];
	const seen = new Set<unknown>();

	const walk = (value: unknown, parentIndex: number | null, depth: number): void => {
		if (depth > MAX_NESTING_DEPTH || value === null || typeof value !== 'object' || seen.has(value)) {
			return;
		}

		seen.add(value);

		if (Array.isArray(value)) {
			for (const item of value) {
				walk(item, parentIndex, depth + 1);
			}

			return;
		}

		if (!isRecord(value)) {
			return;
		}

		if (isToolPart(value)) {
			const callIndex = collected.length + 1;
			collected.push({part: value, parentIndex});

			for (const key of ['parts', 'toolCalls', 'tool_calls', 'calls'] as const) {
				if (key in value) {
					walk(value[key], callIndex, depth + 1);
				}
			}

			return;
		}

		for (const key of NESTED_KEYS) {
			if (key in value) {
				walk(value[key], parentIndex, depth + 1);
			}
		}
	};

	walk(event, null, 0);

	return collected;
};

const statusOf = (state: Record<string, unknown>): ToolStatusType => TOOL_STATUSES.find((status) => status === state['status']) ?? 'unknown';

const outputTextOf = (state: Record<string, unknown>): string => stringAt(state['output']) ?? stringAt(state['error']) ?? '';

const durationOf = (state: Record<string, unknown>): number | null => {
	const time = recordAt(state['time']);
	const start = numberAt(time['start']);
	const end = numberAt(time['end']);

	return start !== null && end !== null && end >= start ? end - start : null;
};

/** Maps provider event aliases onto the tool names declared to the evaluator. */
const canonicalToolOf = (tool: string): string => (tool === 'shell' ? 'bash' : tool);

/**
 * Reads the explicit authority marker from a serialized tool response.
 *
 * @param output - Tool output text.
 * @returns True for stop guidance, false for any other guidance, null when absent.
 */
const authoritativeOf = (output: string): boolean | null => {
	if (output.length === 0) {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(output);

		if (!isRecord(parsed) || !isRecord(parsed['guidance'])) {
			return null;
		}

		const guidance = parsed['guidance'];
		const action = guidance['action'];
		const fallbackRequired = guidance['fallbackRequired'];

		return typeof action === 'string' && typeof fallbackRequired === 'boolean' ? action === 'stop' && !fallbackRequired : null;
	} catch {
		return null;
	}
};

const normalizeToolCall = (part: Record<string, unknown>, input: Readonly<{index: number; rawIndex: number; parentIndex: number | null}>): ToolCallType => {
	const state = recordAt(part['state']);
	const rawInput = state['input'];
	const inputRecord = isRecord(rawInput) ? rawInput : null;
	const tool = canonicalToolOf(stringAt(part['tool']) ?? 'unknown');
	const output = outputTextOf(state);
	const error = stringAt(state['error']);

	return {
		...input,
		id: stringAt(part['callID']) ?? stringAt(part['id']),
		tool,
		family: toolFamilyOf(tool),
		status: statusOf(state),
		input: inputRecord,
		inputValid: inputRecord !== null,
		inputText: JSON.stringify(inputRecord ?? '').slice(0, MAX_INPUT_TEXT),
		outputBytes: Buffer.byteLength(output, 'utf8'),
		authoritative: authoritativeOf(output),
		durationMs: durationOf(state),
		error: error === null ? null : error.slice(0, MAX_ERROR_TEXT),
	};
};

type TelemetryAccumulatorType = Readonly<{sum: number; seen: boolean; exact: boolean}>;

const emptyAccumulator = (): TelemetryAccumulatorType => ({sum: 0, seen: false, exact: true});

const addValue = (accumulator: TelemetryAccumulatorType, value: number | null): TelemetryAccumulatorType => {
	if (value === null) {
		return {...accumulator, exact: false};
	}

	return {sum: accumulator.sum + value, seen: true, exact: accumulator.exact};
};

const entryOf = (options: ParseEventsOptionsType, accumulator: TelemetryAccumulatorType, unit: 'tokens' | 'usd', source: string): TelemetryEntryType => {
	if (options.modelFree === true) {
		return {value: null, state: 'not-applicable', unit, source};
	}

	if (!accumulator.seen || !accumulator.exact) {
		return {value: null, state: 'unavailable', unit, source};
	}

	return {value: accumulator.sum, state: 'exact', unit, source};
};

const emptyTelemetry = (options: ParseEventsOptionsType): TelemetryType => {
	const entry = (unit: 'tokens' | 'usd'): TelemetryEntryType =>
		options.modelFree === true
			? {value: null, state: 'not-applicable', unit, source: 'model-free'}
			: {value: null, state: 'unavailable', unit, source: 'step_finish'};

	return {
		inputTokens: entry('tokens'),
		outputTokens: entry('tokens'),
		reasoningTokens: entry('tokens'),
		cacheReadTokens: entry('tokens'),
		cacheWriteTokens: entry('tokens'),
		reportedCost: entry('usd'),
	};
};

const usageOf = (telemetry: TelemetryType, options: ParseEventsOptionsType): UsageType => ({
	input: telemetry.inputTokens.value ?? 0,
	output: telemetry.outputTokens.value ?? 0,
	reasoning: telemetry.reasoningTokens.value ?? 0,
	cacheRead: telemetry.cacheReadTokens.value ?? 0,
	cacheWrite: telemetry.cacheWriteTokens.value ?? 0,
	cost: telemetry.reportedCost.value ?? 0,
	available: options.modelFree !== true && telemetry.inputTokens.state === 'exact' && telemetry.outputTokens.state === 'exact',
});

/**
 * Parses the line-delimited JSON event stream of `opencode run --format json`.
 *
 * The parser never estimates a missing value. Token components that the client
 * did not report remain present with state `unavailable`, and a malformed or
 * truncated line never discards the events that preceded it.
 *
 * @param stdout - Captured standard output.
 * @param options - Optional model-free marker for structural absence.
 * @returns Derived events, tool calls, telemetry, errors, and final answer text.
 */
export const parseEvents = (stdout: string, options: ParseEventsOptionsType = {}): RunEventsType => {
	const toolCalls: ToolCallType[] = [];
	const events: AgentEventType[] = [];
	const malformed: MalformedEventType[] = [];
	const texts: string[] = [];
	const errors: string[] = [];
	const seenCallIds = new Set<string>();
	const familyBytes: Record<ToolFamilyType, number> = {
		index: 0,
		search: 0,
		read: 0,
		list: 0,
		write: 0,
		execute: 0,
		task: 0,
		other: 0,
	};
	let input = emptyAccumulator();
	let output = emptyAccumulator();
	let reasoning = emptyAccumulator();
	let cacheRead = emptyAccumulator();
	let cacheWrite = emptyAccumulator();
	let cost = emptyAccumulator();
	let steps = 0;
	let rawEventCount = 0;
	let lastNonEmptyFailed = false;

	for (const [lineIndex, line] of stdout.split('\n').entries()) {
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			continue;
		}

		rawEventCount += 1;

		let event: Record<string, unknown>;

		try {
			const parsed: unknown = JSON.parse(trimmed);
			event = recordAt(parsed);

			if (Object.keys(event).length === 0) {
				throw new Error('event is not a JSON object');
			}
		} catch {
			malformed.push({
				line: lineIndex + 1,
				reason: 'invalid JSON event',
				text: trimmed.slice(0, MAX_MALFORMED_TEXT),
			});
			lastNonEmptyFailed = true;
			continue;
		}

		lastNonEmptyFailed = false;

		const rawIndex = lineIndex + 1;
		const part = partOf(event);
		const timestamp = timestampAt(event, part);
		const partType = stringAt(part['type']);
		const eventType = stringAt(event['type']);
		const effectiveType = partType ?? eventType;
		const isText = effectiveType === 'text';
		const isStepStart = effectiveType === 'step_start' || effectiveType === 'step-start';
		const isStepFinish = effectiveType === 'step_finish' || effectiveType === 'step-finish';

		if (isText && stringAt(part['text']) !== null) {
			const text = part['text'] as string;
			texts.push(text);
			events.push({index: events.length + 1, rawIndex, type: 'text', timestamp, text});
		}

		const collected = toolPartsOf(event);
		const firstCallIndex = toolCalls.length + 1;

		for (const item of collected) {
			const call = normalizeToolCall(item.part, {
				index: toolCalls.length + 1,
				rawIndex,
				parentIndex: item.parentIndex === null ? null : firstCallIndex + item.parentIndex - 1,
			});

			if (call.id !== null && seenCallIds.has(call.id)) {
				continue;
			}

			if (call.id !== null) {
				seenCallIds.add(call.id);
			}

			toolCalls.push(call);
			familyBytes[call.family] += call.outputBytes;
			events.push({
				index: events.length + 1,
				rawIndex,
				type: 'tool',
				timestamp,
				callIndex: call.index,
				tool: call.tool,
				status: call.status,
			});
		}

		const namesToolEvent = eventType === 'tool_use' || eventType === 'tool' || partType === 'tool';

		if (namesToolEvent && collected.length === 0) {
			// The envelope named a tool event but no tool part survived
			// normalization. Keep the failure visible instead of dropping it.
			const missing = {index: toolCalls.length + 1, rawIndex, parentIndex: null};
			const call = normalizeToolCall({tool: 'unknown', state: {status: 'unknown'}}, missing);

			toolCalls.push(call);
			events.push({index: events.length + 1, rawIndex, type: 'tool', timestamp, callIndex: call.index, tool: call.tool, status: call.status});
		}

		if (isStepStart) {
			events.push({index: events.length + 1, rawIndex, type: 'step_start', timestamp});
		}

		if (isStepFinish) {
			steps += 1;
			const tokens = recordAt(part['tokens']);
			const cache = recordAt(tokens['cache']);

			input = addValue(input, numberAt(tokens['input']));
			output = addValue(output, numberAt(tokens['output']));
			reasoning = addValue(reasoning, numberAt(tokens['reasoning']));
			cacheRead = addValue(cacheRead, numberAt(cache['read']));
			cacheWrite = addValue(cacheWrite, numberAt(cache['write']));
			cost = addValue(cost, numberAt(part['cost']));
			events.push({index: events.length + 1, rawIndex, type: 'step_finish', timestamp});
		}

		if (eventType === 'error' || eventType === 'session.error') {
			const message = errorMessageOf(event);
			errors.push(message);
			events.push({index: events.length + 1, rawIndex, type: 'error', timestamp, message});
			continue;
		}

		if (isText || isStepStart || isStepFinish) {
			continue;
		}

		if (toolCalls.some((call) => call.rawIndex === rawIndex)) {
			continue;
		}

		events.push({index: events.length + 1, rawIndex, type: 'other', timestamp, rawType: eventType ?? 'unknown'});
	}

	const telemetry: TelemetryType =
		steps === 0
			? emptyTelemetry(options)
			: {
					inputTokens: entryOf(options, input, 'tokens', 'step_finish'),
					outputTokens: entryOf(options, output, 'tokens', 'step_finish'),
					reasoningTokens: entryOf(options, reasoning, 'tokens', 'step_finish'),
					cacheReadTokens: entryOf(options, cacheRead, 'tokens', 'step_finish.cache.read'),
					cacheWriteTokens: entryOf(options, cacheWrite, 'tokens', 'step_finish.cache.write'),
					reportedCost: entryOf(options, cost, 'usd', 'step_finish.cost'),
				};

	return {
		toolCalls,
		events,
		malformed,
		truncated: lastNonEmptyFailed,
		rawEventCount,
		steps,
		finalText: texts.join('\n').trim(),
		telemetry,
		usage: usageOf(telemetry, options),
		errors,
		outputBytes: toolCalls.reduce((total, call) => total + call.outputBytes, 0),
		familyBytes,
	};
};
