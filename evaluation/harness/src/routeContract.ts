import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {type McpSessionType} from './routeClient.ts';
import {type ContractPlanType} from './routeContractPlan.ts';

/** One model-free interface-contract probe result. */
export type ContractProbeType = Readonly<{
	kind: 'failure' | 'pagination' | 'stale-file' | 'truncation';
	result: 'fail' | 'invalid' | 'pass';
	detail: string;
	observations: Readonly<Record<string, unknown>>;
}>;

const MAX_STALE_ATTEMPTS = 3;
const INDEX_READY_TIMEOUT_MS = 120_000;
const INDEX_READY_POLL_MS = 100;
const STACK_PATTERN = /\n\s+at\s+[^\n]+/u;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'(])(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u;

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

const positionOf = (item: Readonly<Record<string, unknown>>): string => {
	const position = item['startLine'] ?? item['startOffset'];

	return typeof position === 'number' ? String(position) : 'unknown';
};

const itemIdentityOf = (item: Readonly<Record<string, unknown>>): string => {
	if (typeof item['symbolId'] === 'string') {
		return item['symbolId'];
	}

	if (typeof item['id'] === 'string') {
		return item['id'];
	}

	return `${typeof item['path'] === 'string' ? item['path'] : 'unknown'}:${positionOf(item)}`;
};

const withCursor = (args: Readonly<Record<string, unknown>>, cursor: string): Readonly<Record<string, unknown>> => ({...args, cursor});

const currentIndexOf = (data: unknown): boolean => {
	if (!isRecord(data) || data['building'] === true) {
		return false;
	}

	const {freshness} = data;

	if (isRecord(freshness)) {
		return freshness['state'] === 'current';
	}

	return data['refresh'] === 'current';
};

/**
 * Waits until a probe session reports a current index.
 *
 * A probe session may open while its private database is still building. During
 * that window a query can return an empty page with an ok status, which is not
 * a contract failure. Sessions without an index-status surface are left
 * unchanged for focused tests.
 *
 * @param session - Connected artifact.
 */
const waitForCurrentIndex = async (session: McpSessionType): Promise<void> => {
	const deadline = performance.now() + INDEX_READY_TIMEOUT_MS;

	for (;;) {
		const outcome = await session.callTool('index_status', {});

		if (outcome.status !== 'ok' || currentIndexOf(outcome.structured) || performance.now() >= deadline) {
			return;
		}

		await delay(INDEX_READY_POLL_MS);
	}
};

const callWhenReady = async (
	session: McpSessionType,
	tool: string,
	args: Readonly<Record<string, unknown>>,
): Promise<Awaited<ReturnType<McpSessionType['callTool']>>> => {
	const deadline = performance.now() + INDEX_READY_TIMEOUT_MS;
	let outcome = await session.callTool(tool, args);

	while (outcome.errorCode === 'index_not_ready' && performance.now() < deadline) {
		// A probe session may start before its first index generation is
		// published; the readiness refusal is retried, never mistaken for the
		// contract outcome under test.
		await delay(INDEX_READY_POLL_MS);
		outcome = await session.callTool(tool, args);
	}

	return outcome;
};

/**
 * Verifies cursor paging: the first bounded page is truncated, every page has
 * a usable cursor, no item repeats, and the final page closes the result.
 *
 * @param session - Connected artifact.
 * @param plan - Declared pagination probe.
 * @returns One probe result.
 */
export const paginationProbeOf = async (session: McpSessionType, plan: ContractPlanType['pagination']): Promise<ContractProbeType> => {
	const first = await callWhenReady(session, plan.tool, plan.arguments);

	if (first.status !== 'ok') {
		return {kind: 'pagination', result: 'fail', detail: `first page returned ${first.errorCode ?? 'an error'}`, observations: {pages: 0}};
	}

	const firstState = pageStateOf(first.structured);

	if (!firstState.truncated || firstState.nextCursor === null) {
		return {
			kind: 'pagination',
			result: 'fail',
			detail: 'first bounded page was not truncated with a next cursor',
			observations: {pages: 1, items: itemsOf(first.structured).length},
		};
	}

	const seen = new Set(itemsOf(first.structured).map((item) => itemIdentityOf(item)));
	const firstCount = seen.size;
	let cursor = firstState.nextCursor;
	let pages = 1;

	while (pages < plan.maxPages) {
		// Each cursor page depends on the previous result and must be ordered.
		const outcome = await session.callTool(plan.tool, withCursor(plan.arguments, cursor));

		if (outcome.status !== 'ok') {
			return {kind: 'pagination', result: 'fail', detail: `page ${pages + 1} returned ${outcome.errorCode ?? 'an error'}`, observations: {pages}};
		}

		pages += 1;
		const items = itemsOf(outcome.structured);

		for (const item of items) {
			const identity = itemIdentityOf(item);

			if (seen.has(identity)) {
				return {kind: 'pagination', result: 'fail', detail: `page ${pages} repeated item ${identity}`, observations: {pages, items: seen.size}};
			}

			seen.add(identity);
		}

		const state = pageStateOf(outcome.structured);

		if (!state.truncated) {
			if (state.nextCursor !== null) {
				return {kind: 'pagination', result: 'fail', detail: 'final page reported a cursor after truncation ended', observations: {pages}};
			}

			return {
				kind: 'pagination',
				result: seen.size > firstCount ? 'pass' : 'fail',
				detail: seen.size > firstCount ? `${pages} pages followed without duplicates` : 'cursor pages returned no additional items',
				observations: {pages, firstPageItems: firstCount, items: seen.size},
			};
		}

		if (state.nextCursor === null) {
			return {kind: 'pagination', result: 'fail', detail: `page ${pages} was truncated without a cursor`, observations: {pages}};
		}

		cursor = state.nextCursor;
	}

	return {kind: 'pagination', result: 'fail', detail: `cursor did not complete within ${plan.maxPages} pages`, observations: {pages}};
};

/**
 * Verifies that a deliberately small response budget bounds the payload and
 * reports a stable oversized-result outcome.
 *
 * @param session - Artifact connected with the probe budget.
 * @param plan - Declared truncation probe.
 * @returns One probe result.
 */
export const truncationProbeOf = async (session: McpSessionType, plan: ContractPlanType['truncation']): Promise<ContractProbeType> => {
	const outcome = await callWhenReady(session, plan.tool, plan.arguments);
	const bounded = outcome.responseBytes <= plan.maxResultBytes;
	const oversized = outcome.status === 'error' && outcome.errorCode === 'response_too_large';
	const shortened = outcome.status === 'ok' && isRecord(outcome.structured) && outcome.structured['truncated'] === true;
	const passed = bounded && (oversized || shortened);

	return {
		kind: 'truncation',
		result: passed ? 'pass' : 'fail',
		detail: passed
			? `${outcome.responseBytes} bytes within the ${plan.maxResultBytes}-byte budget`
			: `response of ${outcome.responseBytes} bytes did not report a bounded outcome`,
		observations: {bytes: outcome.responseBytes, budget: plan.maxResultBytes, outcome: outcome.errorCode ?? 'ok'},
	};
};

const staleAttemptOf = async (session: McpSessionType, workspace: string, plan: ContractPlanType['staleFile']): Promise<ContractProbeType> => {
	const symbol = await callWhenReady(session, 'find_symbol', {query: plan.query, match: 'name', path: plan.path, exposure: 'any'});
	const match = itemsOf(symbol.structured).find((item) => item['path'] === plan.path && item['name'] === plan.query) ?? itemsOf(symbol.structured)[0];
	const symbolId = match?.['symbolId'];

	if (symbol.status !== 'ok' || typeof symbolId !== 'string') {
		return {
			kind: 'stale-file',
			result: 'invalid',
			detail: `could not resolve ${plan.query} in ${plan.path}`,
			observations: {error: symbol.errorCode ?? 'no symbol'},
		};
	}

	const target = path.resolve(workspace, plan.path);

	for (let attempt = 1; attempt <= MAX_STALE_ATTEMPTS; attempt += 1) {
		appendFileSync(target, `\n// route-contract-stale-probe-${attempt}\n`, 'utf8');
		// The write must be visible before read_symbol verifies the indexed hash.
		const outcome = await session.callTool('read_symbol', {symbolId, mode: 'text'});

		if (outcome.status === 'error' && outcome.errorCode === 'stale_file') {
			return {kind: 'stale-file', result: 'pass', detail: `read_symbol refused the changed file on attempt ${attempt}`, observations: {attempts: attempt}};
		}

		if (outcome.status === 'ok' && attempt === MAX_STALE_ATTEMPTS) {
			return {kind: 'stale-file', result: 'fail', detail: 'read_symbol returned source after the indexed file changed', observations: {attempts: attempt}};
		}
	}

	return {kind: 'stale-file', result: 'fail', detail: 'stale-file refusal was not observed', observations: {attempts: MAX_STALE_ATTEMPTS}};
};

/**
 * Verifies stale-file refusal and restores the workspace afterwards.
 *
 * @param session - Connected artifact.
 * @param workspace - Treatment workspace under test.
 * @param plan - Declared stale-file probe.
 * @param restore - Restoration callback supplied by the caller.
 * @returns One probe result.
 */
export const staleFileProbeOf = async (
	session: McpSessionType,
	workspace: string,
	plan: ContractPlanType['staleFile'],
	restore: () => void,
): Promise<ContractProbeType> => {
	try {
		return await staleAttemptOf(session, workspace, plan);
	} catch (error) {
		return {kind: 'stale-file', result: 'invalid', detail: error instanceof Error ? error.message : String(error), observations: {}};
	} finally {
		restore();
	}
};

/**
 * Verifies a stable failure envelope without stack traces or absolute paths.
 *
 * @param session - Connected artifact.
 * @param plan - Declared failure probe.
 * @returns One probe result.
 */
export const failureProbeOf = async (session: McpSessionType, plan: ContractPlanType['failure']): Promise<ContractProbeType> => {
	const outcome = await callWhenReady(session, plan.tool, plan.arguments);
	const leaks = [STACK_PATTERN.test(outcome.text) ? 'stack-trace' : null, ABSOLUTE_PATH_PATTERN.test(outcome.text) ? 'absolute-path' : null].filter(
		(leak): leak is string => leak !== null,
	);
	const passed = outcome.status === 'error' && outcome.errorCode === plan.expectedErrorCode && leaks.length === 0;

	return {
		kind: 'failure',
		result: passed ? 'pass' : 'fail',
		detail: passed ? `stable ${plan.expectedErrorCode} envelope` : `expected ${plan.expectedErrorCode}, observed ${outcome.errorCode ?? 'a success'}`,
		observations: {errorCode: outcome.errorCode, leaks},
	};
};

/**
 * Runs every declared contract probe against one artifact.
 *
 * @param input - Session factory, workspace, restore callback, and probe plan.
 * @returns Probe results in a stable order.
 */
export const runContractProbes = async (
	input: Readonly<{
		session: McpSessionType;
		openSession: (env: Readonly<Record<string, string>>) => Promise<McpSessionType>;
		workspace: string;
		plan: ContractPlanType;
		restore: () => void;
	}>,
): Promise<readonly ContractProbeType[]> => {
	await waitForCurrentIndex(input.session);
	const pagination = await paginationProbeOf(input.session, input.plan.pagination);
	const truncationSession = await input.openSession({CODE_INDEX_MAX_RESULT_BYTES: String(input.plan.truncation.maxResultBytes)});

	try {
		await waitForCurrentIndex(truncationSession);
		const truncation = await truncationProbeOf(truncationSession, input.plan.truncation);
		const failure = await failureProbeOf(input.session, input.plan.failure);
		const staleFile = await staleFileProbeOf(input.session, input.workspace, input.plan.staleFile, input.restore);

		return [pagination, truncation, staleFile, failure];
	} finally {
		await truncationSession.close();
	}
};
