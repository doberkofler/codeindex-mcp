import {
	type AgentEventType,
	type MalformedEventType,
	type ParseEventsOptionsType,
	type RunEventsType,
	type TelemetryEntryType,
	type TelemetryType,
	type ToolCallType,
	type ToolFamilyType,
	type UsageType,
} from './eventsModel.ts';
import {MAX_MALFORMED_TEXT, errorMessageOf, normalizeToolCall, numberAt, partOf, recordAt, stringAt, timestampAt, toolPartsOf} from './eventsTools.ts';

export {TOOL_FAMILIES, type ParseEventsOptionsType, type RunEventsType, type TelemetryType, type ToolCallType, type ToolFamilyType} from './eventsModel.ts';
export {isRateLimited, toolFamilyOf} from './eventsTools.ts';

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
/** Mutable accumulator for one event stream. */
type EventsStateType = {
	toolCalls: ToolCallType[];
	events: AgentEventType[];
	malformed: MalformedEventType[];
	texts: string[];
	errors: string[];
	seenCallIds: Set<string>;
	familyBytes: Record<ToolFamilyType, number>;
	input: TelemetryAccumulatorType;
	output: TelemetryAccumulatorType;
	reasoning: TelemetryAccumulatorType;
	cacheRead: TelemetryAccumulatorType;
	cacheWrite: TelemetryAccumulatorType;
	cost: TelemetryAccumulatorType;
	steps: number;
	rawEventCount: number;
	lastNonEmptyFailed: boolean;
};

const emptyFamilyBytes = (): Record<ToolFamilyType, number> => ({index: 0, search: 0, read: 0, list: 0, write: 0, execute: 0, task: 0, other: 0});

const stateOf = (): EventsStateType => ({
	toolCalls: [],
	events: [],
	malformed: [],
	texts: [],
	errors: [],
	seenCallIds: new Set<string>(),
	familyBytes: emptyFamilyBytes(),
	input: emptyAccumulator(),
	output: emptyAccumulator(),
	reasoning: emptyAccumulator(),
	cacheRead: emptyAccumulator(),
	cacheWrite: emptyAccumulator(),
	cost: emptyAccumulator(),
	steps: 0,
	rawEventCount: 0,
	lastNonEmptyFailed: false,
});

type LineContextType = Readonly<{part: Record<string, unknown>; rawIndex: number; timestamp: number | null}>;

const applyTextOf = (state: EventsStateType, context: LineContextType): void => {
	const text = stringAt(context.part['text']);

	if (text === null) {
		return;
	}

	state.texts.push(text);
	state.events.push({index: state.events.length + 1, rawIndex: context.rawIndex, type: 'text', timestamp: context.timestamp, text});
};

const applyToolsOf = (
	state: EventsStateType,
	context: LineContextType & Readonly<{event: Record<string, unknown>; eventType: string | null; partType: string | null}>,
): void => {
	const collected = toolPartsOf(context.event);
	const firstCallIndex = state.toolCalls.length + 1;

	for (const item of collected) {
		const call = normalizeToolCall(item.part, {
			index: state.toolCalls.length + 1,
			rawIndex: context.rawIndex,
			parentIndex: item.parentIndex === null ? null : firstCallIndex + item.parentIndex - 1,
		});

		if (call.id !== null && state.seenCallIds.has(call.id)) {
			continue;
		}

		if (call.id !== null) {
			state.seenCallIds.add(call.id);
		}

		state.toolCalls.push(call);
		state.familyBytes[call.family] += call.outputBytes;
		state.events.push({
			index: state.events.length + 1,
			rawIndex: context.rawIndex,
			type: 'tool',
			timestamp: context.timestamp,
			callIndex: call.index,
			tool: call.tool,
			status: call.status,
		});
	}

	const namesToolEvent = context.eventType === 'tool_use' || context.eventType === 'tool' || context.partType === 'tool';

	if (namesToolEvent && collected.length === 0) {
		// The envelope named a tool event but no tool part survived normalization.
		// Keep the failure visible instead of dropping it.
		const call = normalizeToolCall(
			{tool: 'unknown', state: {status: 'unknown'}},
			{index: state.toolCalls.length + 1, rawIndex: context.rawIndex, parentIndex: null},
		);

		state.toolCalls.push(call);
		state.events.push({
			index: state.events.length + 1,
			rawIndex: context.rawIndex,
			type: 'tool',
			timestamp: context.timestamp,
			callIndex: call.index,
			tool: call.tool,
			status: call.status,
		});
	}
};

const applyStepFinishOf = (state: EventsStateType, part: Record<string, unknown>): void => {
	const tokens = recordAt(part['tokens']);
	const cache = recordAt(tokens['cache']);

	state.steps += 1;
	state.input = addValue(state.input, numberAt(tokens['input']));
	state.output = addValue(state.output, numberAt(tokens['output']));
	state.reasoning = addValue(state.reasoning, numberAt(tokens['reasoning']));
	state.cacheRead = addValue(state.cacheRead, numberAt(cache['read']));
	state.cacheWrite = addValue(state.cacheWrite, numberAt(cache['write']));
	state.cost = addValue(state.cost, numberAt(part['cost']));
};

const applyEventOf = (state: EventsStateType, input: Readonly<{event: Record<string, unknown>; rawIndex: number}>): void => {
	const {event, rawIndex} = input;
	const part = partOf(event);
	const timestamp = timestampAt(event, part);
	const partType = stringAt(part['type']);
	const eventType = stringAt(event['type']);
	const effectiveType = partType ?? eventType;
	const isText = effectiveType === 'text';
	const isStepStart = effectiveType === 'step_start' || effectiveType === 'step-start';
	const isStepFinish = effectiveType === 'step_finish' || effectiveType === 'step-finish';
	const context = {part, rawIndex, timestamp};

	if (isText) {
		applyTextOf(state, context);
	}

	applyToolsOf(state, {...context, event, eventType, partType});

	if (isStepStart) {
		state.events.push({index: state.events.length + 1, rawIndex, type: 'step_start', timestamp});
	}

	if (isStepFinish) {
		applyStepFinishOf(state, part);
		state.events.push({index: state.events.length + 1, rawIndex, type: 'step_finish', timestamp});
	}

	if (eventType === 'error' || eventType === 'session.error') {
		const message = errorMessageOf(event);

		state.errors.push(message);
		state.events.push({index: state.events.length + 1, rawIndex, type: 'error', timestamp, message});

		return;
	}

	if (isText || isStepStart || isStepFinish || state.toolCalls.some((call) => call.rawIndex === rawIndex)) {
		return;
	}

	state.events.push({index: state.events.length + 1, rawIndex, type: 'other', timestamp, rawType: eventType ?? 'unknown'});
};

const telemetryOf = (state: EventsStateType, options: ParseEventsOptionsType): TelemetryType =>
	state.steps === 0
		? emptyTelemetry(options)
		: {
				inputTokens: entryOf(options, state.input, 'tokens', 'step_finish'),
				outputTokens: entryOf(options, state.output, 'tokens', 'step_finish'),
				reasoningTokens: entryOf(options, state.reasoning, 'tokens', 'step_finish'),
				cacheReadTokens: entryOf(options, state.cacheRead, 'tokens', 'step_finish.cache.read'),
				cacheWriteTokens: entryOf(options, state.cacheWrite, 'tokens', 'step_finish.cache.write'),
				reportedCost: entryOf(options, state.cost, 'usd', 'step_finish.cost'),
			};

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
	const state = stateOf();

	for (const [lineIndex, line] of stdout.split('\n').entries()) {
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			continue;
		}

		state.rawEventCount += 1;

		let event: Record<string, unknown>;

		try {
			const parsed: unknown = JSON.parse(trimmed);
			event = recordAt(parsed);

			if (Object.keys(event).length === 0) {
				throw new Error('event is not a JSON object');
			}
		} catch {
			state.malformed.push({line: lineIndex + 1, reason: 'invalid JSON event', text: trimmed.slice(0, MAX_MALFORMED_TEXT)});
			state.lastNonEmptyFailed = true;
			continue;
		}

		state.lastNonEmptyFailed = false;
		applyEventOf(state, {event, rawIndex: lineIndex + 1});
	}

	const telemetry = telemetryOf(state, options);

	return {
		toolCalls: state.toolCalls,
		events: state.events,
		malformed: state.malformed,
		truncated: state.lastNonEmptyFailed,
		rawEventCount: state.rawEventCount,
		steps: state.steps,
		finalText: state.texts.join('\n').trim(),
		telemetry,
		usage: usageOf(telemetry, options),
		errors: state.errors,
		outputBytes: state.toolCalls.reduce((total, call) => total + call.outputBytes, 0),
		familyBytes: state.familyBytes,
	};
};
