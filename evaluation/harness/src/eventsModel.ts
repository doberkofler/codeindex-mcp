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

/** Structural proof that the captured client event stream is complete. */
export type StreamCompletenessType = Readonly<{
	/** True when nothing in the captured stream is missing or unterminated. */
	complete: boolean;
	/** Closed reasons; empty only when `complete` is true. */
	reasons: readonly string[];
	stepsStarted: number;
	stepsFinished: number;
	/** Last execution-level lifecycle event type seen, or null when none was emitted. */
	terminalEvent: string | null;
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
	/** Structural completeness evidence for this capture. */
	stream: StreamCompletenessType;
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
