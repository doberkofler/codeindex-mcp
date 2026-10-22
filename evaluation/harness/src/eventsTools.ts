import {TOOL_STATUSES, type ToolCallType, type ToolFamilyType, type ToolStatusType} from './eventsModel.ts';

const RATE_LIMIT_PATTERN = /rate.?limit|quota.?exceed|too many requests|\b429\b/iu;

export const MAX_ERROR_TEXT = 500;
export const MAX_MALFORMED_TEXT = 500;
export const MAX_INPUT_TEXT = 2000;
export const MAX_NESTING_DEPTH = 4;

export const NESTED_KEYS = ['part', 'parts', 'properties', 'toolCalls', 'tool_calls', 'calls'] as const;

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const recordAt = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export const stringAt = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export const numberAt = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

export const timestampAt = (event: Record<string, unknown>, part: Record<string, unknown>): number | null =>
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
export const errorMessageOf = (event: Record<string, unknown>): string => {
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

export const partOf = (event: Record<string, unknown>): Record<string, unknown> => {
	const direct = recordAt(event['part']);

	if (Object.keys(direct).length > 0) {
		return direct;
	}

	const properties = recordAt(event['properties']);
	const nested = recordAt(properties['part']);

	return Object.keys(nested).length > 0 ? nested : properties;
};

export const isToolPart = (value: unknown): value is Record<string, unknown> =>
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

export type CollectedPartType = Readonly<{part: Record<string, unknown>; parentIndex: number | null}>;

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
export const toolPartsOf = (event: Record<string, unknown>): readonly CollectedPartType[] => {
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

export const statusOf = (state: Record<string, unknown>): ToolStatusType => TOOL_STATUSES.find((status) => status === state['status']) ?? 'unknown';

export const outputTextOf = (state: Record<string, unknown>): string => stringAt(state['output']) ?? stringAt(state['error']) ?? '';

export const durationOf = (state: Record<string, unknown>): number | null => {
	const time = recordAt(state['time']);
	const start = numberAt(time['start']);
	const end = numberAt(time['end']);

	return start !== null && end !== null && end >= start ? end - start : null;
};

/**
 * Maps provider event aliases onto the tool names declared to the evaluator.
 *
 * @param tool - Tool name as the provider reported it.
 * @returns The declared tool name.
 */
export const canonicalToolOf = (tool: string): string => (tool === 'shell' ? 'bash' : tool);

/**
 * Reads the explicit authority marker from a serialized tool response.
 *
 * @param output - Tool output text.
 * @returns True for stop guidance, false for any other guidance, null when absent.
 */
export const authoritativeOf = (output: string): boolean | null => {
	if (output.length === 0) {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(output);

		if (!isRecord(parsed) || !isRecord(parsed['guidance'])) {
			return null;
		}

		const {guidance} = parsed;
		const {action} = guidance;
		const {fallbackRequired} = guidance;

		return typeof action === 'string' && typeof fallbackRequired === 'boolean' ? action === 'stop' && !fallbackRequired : null;
	} catch {
		return null;
	}
};

export const normalizeToolCall = (
	part: Record<string, unknown>,
	input: Readonly<{index: number; rawIndex: number; parentIndex: number | null}>,
): ToolCallType => {
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
