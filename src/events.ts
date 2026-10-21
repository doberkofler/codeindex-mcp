/** One normalized tool invocation. */
export type ToolCallType = Readonly<{
	tool: string;
	status: string;
	/** Characters of tool output, which is the retrieval payload proxy. */
	outputBytes: number;
	/** Serialized tool input, truncated, used to detect code-mode index calls. */
	inputText: string;
}>;

/** Token accounting for one run. */
export type UsageType = Readonly<{
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** False when the client emitted no step_finish usage. */
	available: boolean;
}>;

/** Everything the harness derives from one agent event stream. */
export type RunEventsType = Readonly<{
	toolCalls: readonly ToolCallType[];
	finalText: string;
	usage: UsageType;
	/** Root-level error messages, one per emitted error event. */
	errors: readonly string[];
	/** Summed characters returned by every completed tool call. */
	outputBytes: number;
}>;

/** Provider-side rate limiting, matched across stdout, stderr, and events. */
const RATE_LIMIT_PATTERN = /rate.?limit|quota.?exceed|too many requests|\b429\b/i;

const numberAt = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const recordAt = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/**
 * Reports whether any captured channel shows provider rate limiting.
 *
 * @param channels - Raw stdout, raw stderr, and parsed error messages.
 * @returns True when the execution was throttled rather than wrong.
 */
export const isRateLimited = (...channels: readonly string[]): boolean => channels.some((channel) => RATE_LIMIT_PATTERN.test(channel));

/**
 * Extracts the message of a root-level error event.
 *
 * `opencode run --format json` emits `{"type":"error","error":{...}}` with no
 * `part` object, so the diagnostic lives on the event, not on a part.
 *
 * @param event - Parsed event record.
 * @returns A bounded, human-readable message.
 */
const errorMessageOf = (event: Record<string, unknown>): string => {
	const error = recordAt(event['error']);
	const message = error['message'];
	const type = error['type'];

	if (typeof message === 'string') {
		return (typeof type === 'string' ? `${type}: ${message}` : message).slice(0, 500);
	}

	return JSON.stringify(event).slice(0, 500);
};

/**
 * Parses the line-delimited JSON event stream of `opencode run --format json`.
 *
 * A run whose client emits no usage is reported with `usage.available === false`
 * so the caller can invalidate it instead of inferring token counts.
 *
 * @param stdout - Captured standard output.
 * @returns Derived tool calls, usage, errors, and final answer text.
 */
export const parseEvents = (stdout: string): RunEventsType => {
	const toolCalls: ToolCallType[] = [];
	const texts: string[] = [];
	const errors: string[] = [];
	let input = 0;
	let output = 0;
	let reasoning = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let steps = 0;

	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			continue;
		}

		let event: Record<string, unknown>;

		try {
			event = recordAt(JSON.parse(trimmed) as unknown);
		} catch {
			continue;
		}

		const part = recordAt(event['part']);
		const type = event['type'];

		if (type === 'text' && typeof part['text'] === 'string') {
			texts.push(part['text']);
		}

		if (type === 'tool_use') {
			const state = recordAt(part['state']);
			const tool = typeof part['tool'] === 'string' ? part['tool'] : 'unknown';
			const status = typeof state['status'] === 'string' ? state['status'] : 'unknown';
			const raw = state['output'];

			toolCalls.push({
				tool,
				status,
				outputBytes: typeof raw === 'string' ? raw.length : 0,
				inputText: JSON.stringify(state['input'] ?? '').slice(0, 2_000),
			});
		}

		if (type === 'step_finish') {
			steps += 1;
			const tokens = recordAt(part['tokens']);
			const cache = recordAt(tokens['cache']);
			input += numberAt(tokens['input']);
			output += numberAt(tokens['output']);
			reasoning += numberAt(tokens['reasoning']);
			cacheRead += numberAt(cache['read']);
			cacheWrite += numberAt(cache['write']);
			cost += numberAt(part['cost']);
		}

		if (type === 'error') {
			errors.push(errorMessageOf(event));
		}
	}

	return {
		toolCalls,
		finalText: texts.join('\n').trim(),
		usage: {input, output, reasoning, cacheRead, cacheWrite, cost, available: steps > 0 && input + output > 0},
		errors,
		outputBytes: toolCalls.reduce((total, call) => total + call.outputBytes, 0),
	};
};
