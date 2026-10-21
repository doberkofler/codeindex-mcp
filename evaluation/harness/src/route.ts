import {type McpCallOutcomeType, type McpSessionType} from './routeClient.ts';
import {type McpStepType, type RouteCollectionType, type RouteStepType, type SymbolSelectionType, type TextStepType} from './routePlan.ts';
import {readWorkspaceSource, runTextStep} from './routeText.ts';

/** Treatment identifiers available to a model-free comparison. */
export const ROUTE_TREATMENTS = ['no-index', 'accepted', 'candidate'] as const;

export type RouteTreatmentType = (typeof ROUTE_TREATMENTS)[number];

/** One observed call in a complete route. */
export type RouteCallType = Readonly<{
	stepId: string;
	kind: 'text' | 'mcp';
	tool: string;
	status: 'ok' | 'error';
	elapsedMs: number;
	/** Server-reported core query time; null when it was not observed. */
	coreMs: number | null;
	responseBytes: number;
	errorCode: string | null;
	/** One for an ordinary step or one MCP page. */
	page: number;
}>;

/** Aggregate complete-route metrics for one treatment on one case. */
export type RouteMetricsType = Readonly<{
	callCount: number;
	responseBytes: number;
	elapsedMs: number;
	coreMs: Readonly<{value: number | null; state: 'exact' | 'unavailable'}>;
}>;

/** One complete route result. */
export type RouteRunType = Readonly<{
	caseId: string;
	treatment: RouteTreatmentType;
	answerFiles: readonly string[];
	expectedFiles: readonly string[];
	exact: boolean;
	valid: boolean;
	calls: readonly RouteCallType[];
	metrics: RouteMetricsType;
	defects: readonly string[];
}>;

const MAX_CURSOR_PAGES = 100;
const INDEX_READY_TIMEOUT_MS = 120_000;
const INDEX_READY_POLL_MS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const itemsOf = (data: unknown): readonly Readonly<Record<string, unknown>>[] => {
	if (!isRecord(data) || !Array.isArray(data['items'])) {
		return [];
	}

	return data['items'].filter(isRecord);
};

const pageStateOf = (data: unknown): Readonly<{truncated: boolean; nextCursor: string | null}> => {
	if (!isRecord(data)) {
		return {truncated: false, nextCursor: null};
	}

	return {truncated: data['truncated'] === true, nextCursor: typeof data['nextCursor'] === 'string' ? data['nextCursor'] : null};
};

const pathOf = (item: Readonly<Record<string, unknown>>): string | null => (typeof item['path'] === 'string' ? item['path'] : null);

const roleOf = (item: Readonly<Record<string, unknown>>): string | null => (typeof item['role'] === 'string' ? item['role'] : null);

const matchOf = (item: Readonly<Record<string, unknown>>): string | null => (typeof item['match'] === 'string' ? item['match'] : null);

const nameOf = (item: Readonly<Record<string, unknown>>): string | null => (typeof item['name'] === 'string' ? item['name'] : null);

const selectedSymbolOf = (items: readonly Readonly<Record<string, unknown>>[], selection: SymbolSelectionType): Readonly<Record<string, unknown>> | null => {
	const candidates = items.filter(
		(item) => (selection.path === undefined || pathOf(item) === selection.path) && (selection.name === undefined || nameOf(item) === selection.name),
	);
	const preferred = candidates.find((item) => (matchOf(item) ?? '').startsWith('exact')) ?? candidates[0];

	return preferred ?? null;
};

const argumentsWithSymbol = (
	step: McpStepType,
	itemsByStep: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>,
): Readonly<Record<string, unknown>> => {
	if (step.symbolFrom === undefined) {
		return step.arguments;
	}

	const symbol = selectedSymbolOf(itemsByStep.get(step.symbolFrom.fromStep) ?? [], step.symbolFrom);
	const symbolId = symbol === null ? null : symbol['symbolId'];

	if (typeof symbolId !== 'string') {
		throw new Error(`step "${step.id}" could not resolve a symbol from step "${step.symbolFrom.fromStep}"`);
	}

	return {...step.arguments, symbolId};
};

const collectedPathsOf = (
	collection: RouteCollectionType,
	items: readonly Readonly<Record<string, unknown>>[],
	fallbackName: string | null,
): readonly string[] => {
	if (collection === 'none') {
		return [];
	}

	if (collection === 'exact-name-paths') {
		return items
			.filter((item) => (matchOf(item) ?? '').startsWith('exact') || (fallbackName !== null && nameOf(item) === fallbackName))
			.map(pathOf)
			.filter((path): path is string => path !== null);
	}

	if (collection === 'reference-paths') {
		return items
			.filter((item) => roleOf(item) === 'reference')
			.map(pathOf)
			.filter((path): path is string => path !== null);
	}

	if (collection === 'definition-paths') {
		return items
			.filter((item) => roleOf(item) === 'definition')
			.map(pathOf)
			.filter((path): path is string => path !== null);
	}

	return items.map(pathOf).filter((path): path is string => path !== null);
};

const metricsOf = (calls: readonly RouteCallType[]): RouteMetricsType => {
	const unavailable = calls.some((call) => call.coreMs === null);
	const core = calls.reduce((sum, call) => sum + (call.coreMs ?? 0), 0);

	return {
		callCount: calls.length,
		responseBytes: calls.reduce((sum, call) => sum + call.responseBytes, 0),
		elapsedMs: calls.reduce((sum, call) => sum + call.elapsedMs, 0),
		coreMs: unavailable ? {value: null, state: 'unavailable'} : {value: core, state: 'exact'},
	};
};

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const textCallOf = (stepId: string, tool: string, result: Readonly<{bytes: number; calls: number}>): readonly RouteCallType[] =>
	Array.from({length: result.calls}, (_, index) => ({
		stepId,
		kind: 'text' as const,
		tool,
		status: 'ok' as const,
		elapsedMs: 0,
		coreMs: 0,
		responseBytes: result.bytes,
		errorCode: null,
		page: index + 1,
	}));

type ExecutionStateType = Readonly<{
	calls: RouteCallType[];
	answer: Set<string>;
	itemsByStep: Map<string, readonly Readonly<Record<string, unknown>>[]>;
	defects: string[];
}>;

const executeText = (state: ExecutionStateType, workspace: string, step: TextStepType): void => {
	const startedAt = performance.now();
	const result = runTextStep({workspace, step});
	const elapsedMs = performance.now() - startedAt;

	if (step.collect) {
		for (const path of result.paths) {
			state.answer.add(path);
		}
	}

	state.calls.push(...textCallOf(step.id, step.kind, result).map((call) => ({...call, elapsedMs, coreMs: elapsedMs})));
};

const filterKeptFiles = (state: ExecutionStateType, workspace: string, step: McpStepType, paths: readonly string[]): readonly string[] => {
	if (step.keepFilesMatching === undefined) {
		return paths;
	}

	const regex = new RegExp(step.keepFilesMatching, 'u');
	const kept: string[] = [];

	for (const path of paths) {
		const startedAt = performance.now();
		const source = readWorkspaceSource(workspace, path);
		const elapsedMs = performance.now() - startedAt;

		state.calls.push({
			stepId: step.id,
			kind: 'text',
			tool: 'read',
			status: 'ok',
			elapsedMs,
			coreMs: elapsedMs,
			responseBytes: source.bytes,
			errorCode: null,
			page: 1,
		});

		if (regex.test(source.text)) {
			kept.push(path);
		}
	}

	return kept;
};

const executeMcpPage = async (
	state: ExecutionStateType,
	client: McpSessionType,
	step: McpStepType,
	args: Readonly<Record<string, unknown>>,
	page: number,
): Promise<McpCallOutcomeType> => {
	const outcome = await client.callTool(step.tool, args);
	const data = outcome.structured;

	state.calls.push({
		stepId: step.id,
		kind: 'mcp',
		tool: step.tool,
		status: outcome.status,
		elapsedMs: outcome.elapsedMs,
		coreMs: outcome.coreMs,
		responseBytes: outcome.responseBytes,
		errorCode: outcome.errorCode,
		page,
	});

	if (outcome.status !== 'ok') {
		state.defects.push(`${step.id} returned ${outcome.errorCode ?? 'an error'}${outcome.errorMessage === null ? '' : `: ${outcome.errorMessage}`}`);
		return outcome;
	}

	state.itemsByStep.set(step.id, [...(state.itemsByStep.get(step.id) ?? []), ...itemsOf(data)]);

	return outcome;
};

const readyOf = (data: unknown): boolean => isRecord(data) && (data['ready'] === true || data['state'] === 'published');

const waitForIndexReady = async (state: ExecutionStateType, client: McpSessionType): Promise<void> => {
	const deadline = performance.now() + INDEX_READY_TIMEOUT_MS;
	let page = 1;

	while (performance.now() < deadline) {
		// Readiness is a prerequisite for every query route; each poll is retained
		// in the complete-route call record.
		const outcome = await executeMcpPage(state, client, {kind: 'mcp', id: 'index-ready', tool: 'index_status', arguments: {}, collect: 'none'}, {}, page);

		if (outcome.status !== 'ok' || readyOf(outcome.structured)) {
			return;
		}

		page += 1;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, INDEX_READY_POLL_MS);
		});
	}

	state.defects.push(`index did not become ready within ${INDEX_READY_TIMEOUT_MS} ms`);
};

const executeMcp = async (state: ExecutionStateType, client: McpSessionType, workspace: string, step: McpStepType): Promise<void> => {
	const baseArgs = argumentsWithSymbol(step, state.itemsByStep);
	let args = baseArgs;
	let page = 1;
	let complete = false;

	while (!complete) {
		// Cursor pages are sequential by definition: each next page depends on the
		// cursor returned by the previous call.
		const outcome = await executeMcpPage(state, client, step, args, page);

		if (outcome.status !== 'ok') {
			return;
		}

		const pageState = pageStateOf(outcome.structured);

		if (step.followCursor !== true || !pageState.truncated) {
			complete = true;
			continue;
		}

		if (pageState.nextCursor === null) {
			state.defects.push(`${step.id} reported truncation without a next cursor`);
			return;
		}

		if (page >= MAX_CURSOR_PAGES) {
			state.defects.push(`${step.id} exceeded ${MAX_CURSOR_PAGES} cursor pages`);
			return;
		}

		args = {...baseArgs, cursor: pageState.nextCursor};
		page += 1;
	}

	const collected = collectedPathsOf(
		step.collect,
		state.itemsByStep.get(step.id) ?? [],
		step.exactName ?? (typeof step.arguments['query'] === 'string' ? step.arguments['query'] : null),
	);
	const excluded = new Set(step.excludePaths ?? []);
	const paths = collected.filter((path) => !excluded.has(path));

	for (const path of filterKeptFiles(state, workspace, step, paths)) {
		state.answer.add(path);
	}
};

/**
 * Executes one complete declared route against one workspace.
 *
 * Every step is retained, including setup, fallback, cursor pages, and
 * post-search reads. A step failure makes the route invalid instead of
 * silently returning a partial answer.
 *
 * @param input - Case identity, treatment, steps, workspace, and MCP session.
 * @returns The observed answer, calls, aggregate metrics, and defects.
 */
export const runRoute = async (
	input: Readonly<{
		caseId: string;
		treatment: RouteTreatmentType;
		steps: readonly RouteStepType[];
		workspace: string;
		expectedFiles: readonly string[];
		client: McpSessionType | null;
		/** Poll `index_status` until the artifact publishes a usable generation. */
		awaitIndexReady?: boolean;
	}>,
): Promise<RouteRunType> => {
	const state: ExecutionStateType = {calls: [], answer: new Set(), itemsByStep: new Map(), defects: []};

	if (input.awaitIndexReady === true && input.client !== null) {
		await waitForIndexReady(state, input.client);
	}

	for (const step of input.steps) {
		if (state.defects.length > 0) {
			break;
		}

		try {
			if (step.kind === 'mcp') {
				if (input.client === null) {
					state.defects.push(`step "${step.id}" requires a CodeIndex artifact, but no session is open`);
					break;
				}

				await executeMcp(state, input.client, input.workspace, step);
			} else {
				executeText(state, input.workspace, step);
			}
		} catch (error) {
			state.defects.push(`step "${step.id}" failed: ${errorOf(error)}`);
			break;
		}

		if (state.defects.length > 0) {
			break;
		}
	}

	const answerFiles = [...state.answer].sort();
	const expectedFiles = [...input.expectedFiles].sort();
	const exact = state.defects.length === 0 && answerFiles.length === expectedFiles.length && answerFiles.every((file, index) => file === expectedFiles[index]);

	return {
		caseId: input.caseId,
		treatment: input.treatment,
		answerFiles,
		expectedFiles,
		exact,
		valid: state.defects.length === 0,
		calls: state.calls,
		metrics: metricsOf(state.calls),
		defects: state.defects,
	};
};
