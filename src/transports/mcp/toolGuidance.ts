/**
 * Machine-readable next action attached to one successful tool result.
 *
 * `stop` marks an authoritative, non-empty, current, untruncated result.
 * `text_search` marks the only cases where a repository fallback is required.
 */
export type ToolGuidanceType = Readonly<{
	readonly action: 'stop' | 'follow_cursor' | 'refine' | 'text_search' | 'retry';
	readonly fallbackRequired: boolean;
	readonly message: string;
}>;

const STOP_MESSAGE = 'Complete result; no fallback search is required.';
const CURSOR_MESSAGE = 'Result is truncated; follow nextCursor before answering.';
const REFINE_MESSAGE = 'Multiple stored symbols match; choose one candidate before answering.';
const TEXT_SEARCH_MESSAGE = 'No stored match; this is not evidence of absence. Use a repository text search as the fallback.';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const freshnessOf = (data: Readonly<Record<string, unknown>>): string | null => {
	const {freshness} = data;

	if (typeof freshness === 'string') {
		return freshness;
	}

	return isRecord(freshness) && typeof freshness['state'] === 'string' ? freshness['state'] : null;
};

const isEmptyOf = (data: Readonly<Record<string, unknown>>): boolean => {
	if (Array.isArray(data['items'])) {
		return data['items'].length === 0;
	}

	if (Array.isArray(data['candidates'])) {
		return data['candidates'].length === 0;
	}

	if (typeof data['source'] === 'string') {
		return data['source'].length === 0;
	}

	return true;
};

/**
 * Derives stop or fallback guidance from a successful tool payload.
 *
 * The guidance is deliberately transferable: the transport attaches it to the
 * envelope, and the core result schema remains unchanged.
 *
 * @param tool - Registered tool name.
 * @param data - Successful, projected result data.
 * @returns Guidance for a query result, or null for status and unknown shapes.
 */
export const toolGuidanceOf = (tool: string, data: unknown): ToolGuidanceType | null => {
	if (tool === 'index_status' || !isRecord(data)) {
		return null;
	}

	if (data['kind'] === 'none' || data['reason'] === 'no_stored_match') {
		return {action: 'text_search', fallbackRequired: true, message: TEXT_SEARCH_MESSAGE};
	}

	if (data['kind'] === 'ambiguous') {
		return {action: 'refine', fallbackRequired: false, message: REFINE_MESSAGE};
	}

	const freshness = freshnessOf(data);

	if (freshness === 'stale' || freshness === 'unknown') {
		return {
			action: 'text_search',
			fallbackRequired: true,
			message: `The index is ${freshness}; confirm with a repository text search or direct file read.`,
		};
	}

	if (freshness === 'updating') {
		return {
			action: 'retry',
			fallbackRequired: false,
			message: 'The index is updating; results may omit the latest edits.',
		};
	}

	if (data['truncated'] === true || (data['nextCursor'] !== null && data['nextCursor'] !== undefined)) {
		return {action: 'follow_cursor', fallbackRequired: false, message: CURSOR_MESSAGE};
	}

	return isEmptyOf(data)
		? {action: 'text_search', fallbackRequired: true, message: TEXT_SEARCH_MESSAGE}
		: {action: 'stop', fallbackRequired: false, message: STOP_MESSAGE};
};
