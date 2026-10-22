import {assertionOf, resultOf, violationsOf, type AssertionType, type CheckResultType} from './assertions.ts';
import {canonicalJson} from './hash.ts';
import {TOOL_FAMILIES, type RunEventsType, type ToolCallType, type ToolFamilyType} from './events.ts';
import {type CaseType, type FamilyLimitsType} from './schema.ts';

/** Families that retrieve repository evidence rather than mutate or delegate. */
export const RETRIEVAL_FAMILIES = ['index', 'search', 'read', 'list'] as const;

/** Workflow assessment kept separate from correctness and process outcome. */
export type WorkflowResultType = Readonly<{
	result: CheckResultType;
	/** True only when every declared workflow predicate passed. */
	compliant: boolean;
	violations: readonly string[];
	assertions: readonly AssertionType[];
	/** Calls classified as structurally broad searches. */
	broadSearches: readonly number[];
	/** Repeated reads of one exact, validated input. */
	duplicateReads: number;
	/** Retrieval calls made after a successful authoritative index result. */
	fallbacksAfterAuthoritative: number;
	/** First call in a retrieval family, or null when none was made. */
	firstRetrievalTool: string | null;
}>;

const SCOPE_PATH_KEYS = ['path', 'paths', 'dir', 'directory', 'cwd', 'root', 'file', 'files'] as const;
const SCOPE_INCLUDE_KEYS = ['include', 'includes', 'glob', 'globs'] as const;
const BROAD_SEARCH_TOOLS = new Set(['grep', 'glob', 'codesearch', 'search']);
const FALLBACK_FAMILIES = new Set<ToolFamilyType>(['search', 'read', 'list', 'execute']);

const isRetrievalFamily = (family: ToolFamilyType): boolean => (RETRIEVAL_FAMILIES as readonly string[]).includes(family);

const normalizeScope = (value: string): string => {
	let normalized = value.trim().replaceAll('\\', '/');

	while (normalized.startsWith('./')) {
		normalized = normalized.slice(2);
	}

	return normalized;
};

/**
 * Returns the directory prefix before the first glob metacharacter.
 *
 * The classifier uses only structural scope. It never inspects a query string,
 * because a literal shared by many files does not make a scoped search broad.
 *
 * @param value - Declared path, include, or glob.
 * @returns The bounded prefix, or an empty string when the scope starts at root.
 */
const globRootOf = (value: string): string => {
	const normalized = normalizeScope(value);
	const firstMeta = normalized.search(/[*?[{]/u);

	if (firstMeta < 0) {
		return normalized;
	}

	return normalized.slice(0, firstMeta).replace(/\/+$/u, '');
};

const isRootScope = (value: string): boolean => {
	const root = globRootOf(value);

	return root.length === 0 || root === '.' || root === '/';
};

const scopeValuesOf = (value: unknown): readonly string[] => {
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string');
	}

	return [];
};

const inputScopesOf = (call: ToolCallType, keys: readonly string[]): readonly string[] => {
	if (call.input === null) {
		return [];
	}

	return keys.flatMap((key) => scopeValuesOf(call.input?.[key]));
};

/**
 * Classifies a search call as structurally broad.
 *
 * A call is broad when it declares no repository scope, or when its effective
 * path/include scope starts at the repository root. A narrow include under a
 * bounded path stays bounded; the tool name and query text are irrelevant.
 *
 * @param call - Normalized tool call with validated input.
 * @returns True when the search observes the whole repository.
 */
export const isBroadSearch = (call: ToolCallType): boolean => {
	if (call.family !== 'search' || !BROAD_SEARCH_TOOLS.has(call.tool)) {
		return false;
	}

	if (!call.inputValid || call.input === null) {
		return true;
	}

	const paths = inputScopesOf(call, SCOPE_PATH_KEYS);
	const includes = inputScopesOf(call, SCOPE_INCLUDE_KEYS);
	const pattern = call.tool === 'glob' ? scopeValuesOf(call.input['pattern']) : [];
	const narrowedBy = [...includes, ...pattern];

	if (paths.length === 0) {
		if (narrowedBy.length === 0) {
			return true;
		}

		return narrowedBy.some((scope) => isRootScope(scope));
	}

	// A root path is only broad when no declared include narrows it. A narrow
	// path stays bounded even when its include is recursive.
	return paths.some((path) => isRootScope(path)) && (narrowedBy.length === 0 || narrowedBy.some((scope) => isRootScope(scope)));
};

const broadSearchesOf = (calls: readonly ToolCallType[]): readonly number[] => calls.filter((call) => isBroadSearch(call)).map((call) => call.index);

const readKeyOf = (call: ToolCallType): string | null =>
	call.family === 'read' && call.inputValid && call.input !== null ? `${call.tool}\u0000${canonicalJson(call.input)}` : null;

const duplicateReadsOf = (calls: readonly ToolCallType[]): number => {
	const seen = new Set<string>();
	let duplicates = 0;

	for (const call of calls) {
		const key = readKeyOf(call);

		if (key === null) {
			continue;
		}

		if (seen.has(key)) {
			duplicates += 1;
		} else {
			seen.add(key);
		}
	}

	return duplicates;
};

/**
 * Reports whether one index call returned an authoritative answer.
 *
 * New artifacts mark authority explicitly. Pre-guidance artifacts keep the
 * historical non-empty-success heuristic, except for `index_status`, which is
 * not an answer and must never count as one.
 *
 * @param call - Normalized tool call.
 * @returns True when a fallback after this call is wasteful.
 */
const isAuthoritativeIndexCall = (call: ToolCallType): boolean =>
	call.family === 'index' && call.status === 'completed' && (call.authoritative ?? (call.outputBytes > 0 && call.tool !== 'codeindex_index_status'));

const fallbacksAfterAuthoritativeOf = (calls: readonly ToolCallType[]): number => {
	const authoritative = calls.find((call) => isAuthoritativeIndexCall(call));

	if (authoritative === undefined) {
		return 0;
	}

	return calls.filter((call) => call.index > authoritative.index && FALLBACK_FAMILIES.has(call.family)).length;
};

const firstRetrievalOf = (calls: readonly ToolCallType[]): string | null => calls.find((call) => isRetrievalFamily(call.family))?.tool ?? null;

const familyCountOf = (calls: readonly ToolCallType[], family: ToolFamilyType): number => calls.filter((call) => call.family === family).length;

const limitAssertionsOf = (kind: string, limits: FamilyLimitsType, observedOf: (family: ToolFamilyType) => number): readonly AssertionType[] =>
	Object.entries(limits).map(([key, limit]) => {
		const family = TOOL_FAMILIES.find((candidate) => candidate === key);

		if (family === undefined) {
			throw new Error(`${kind} declares an unknown tool family "${key}"`);
		}

		return assertionOf({
			id: `${kind}.${family}`,
			kind,
			expected: {max: limit},
			observed: observedOf(family),
			result: observedOf(family) <= limit ? 'pass' : 'fail',
		});
	});

const tokenTotalOf = (events: RunEventsType): number | null => {
	const entries = [events.telemetry.inputTokens, events.telemetry.outputTokens, events.telemetry.reasoningTokens];

	if (!entries.every((entry) => entry.state === 'exact' && entry.value !== null)) {
		return null;
	}

	return entries.reduce((total, entry) => total + (entry.value ?? 0), 0);
};

/** Structural observations shared by the optional workflow assertions. */
type WorkflowObservationsType = Readonly<{
	firstRetrievalTool: string | null;
	broadSearches: readonly number[];
	duplicateReads: number;
	fallbacksAfterAuthoritative: number;
}>;

/**
 * Builds the assertions that only apply when the case declares their limit.
 *
 * @param workflow - Case workflow policy.
 * @param observations - Counts observed for this execution.
 * @param durationMs - Harness-measured wall time.
 * @param events - Parsed events, used for the token budget.
 * @returns Every optional assertion that the policy enables.
 */
const optionalAssertionsOf = (
	workflow: CaseType['workflow'],
	observations: WorkflowObservationsType,
	durationMs: number,
	events: RunEventsType,
): readonly AssertionType[] => {
	const {firstRetrievalTool, broadSearches, duplicateReads, fallbacksAfterAuthoritative} = observations;
	const assertions: AssertionType[] = [];

	if (workflow.requiredFirstTool !== null) {
		assertions.push(
			assertionOf({
				id: 'tools.first-retrieval',
				kind: 'tools',
				expected: workflow.requiredFirstTool,
				observed: firstRetrievalTool,
				result: firstRetrievalTool === workflow.requiredFirstTool ? 'pass' : 'fail',
			}),
		);
	}

	if (workflow.maxDuplicateReads !== null) {
		assertions.push(
			assertionOf({
				id: 'reads.duplicate',
				kind: 'reads',
				expected: {max: workflow.maxDuplicateReads},
				observed: duplicateReads,
				result: duplicateReads <= workflow.maxDuplicateReads ? 'pass' : 'fail',
			}),
		);
	}

	if (workflow.maxFallbacksAfterAuthoritative !== null) {
		assertions.push(
			assertionOf({
				id: 'routing.fallback-after-authoritative',
				kind: 'routing',
				expected: {max: workflow.maxFallbacksAfterAuthoritative},
				observed: fallbacksAfterAuthoritative,
				result: fallbacksAfterAuthoritative <= workflow.maxFallbacksAfterAuthoritative ? 'pass' : 'fail',
			}),
		);
	}

	if (workflow.maxBroadSearches !== null) {
		assertions.push(
			assertionOf({
				id: 'search.broad',
				kind: 'search',
				expected: {max: workflow.maxBroadSearches},
				observed: broadSearches,
				result: broadSearches.length <= workflow.maxBroadSearches ? 'pass' : 'fail',
			}),
		);
	}

	if (workflow.maxDurationMs !== null) {
		assertions.push(
			assertionOf({
				id: 'time.max-duration',
				kind: 'time',
				expected: {max: workflow.maxDurationMs},
				observed: durationMs,
				result: durationMs <= workflow.maxDurationMs ? 'pass' : 'fail',
			}),
		);
	}

	if (workflow.maxTokens !== null) {
		const tokens = tokenTotalOf(events);

		assertions.push(
			assertionOf({
				id: 'tokens.uncached',
				kind: 'tokens',
				expected: {max: workflow.maxTokens},
				observed: tokens,
				result: tokens === null ? 'unevaluated' : tokens <= workflow.maxTokens ? 'pass' : 'fail',
			}),
		);
	}

	return assertions;
};

/**
 * Assesses the declarative workflow gates for one run.
 *
 * The result is independent of answer correctness and process success.
 * Predicates without declared bounds are not graded; a predicate that needs an
 * unavailable measurement is `unevaluated`, never a pass and never a zero.
 *
 * @param testCase - Case policy.
 * @param events - Parsed events.
 * @param durationMs - Harness-measured wall time for the execution.
 * @returns Compliance, assertions, and structural observations.
 */
export const workflowOf = (testCase: CaseType, events: RunEventsType, durationMs: number): WorkflowResultType => {
	const calls = events.toolCalls;
	const {workflow} = testCase;
	const observedTools = new Set([...new Set(calls.map((call) => call.tool))].sort());
	const missingTools = workflow.requiredTools.filter((tool) => !observedTools.has(tool));
	const forbidden = workflow.forbiddenTools.filter((tool) => observedTools.has(tool));
	const firstRetrievalTool = firstRetrievalOf(calls);
	const broadSearches = broadSearchesOf(calls);
	const duplicateReads = duplicateReadsOf(calls);
	const fallbacksAfterAuthoritative = fallbacksAfterAuthoritativeOf(calls);

	const assertions: AssertionType[] = [
		assertionOf({
			id: 'budget.total-calls',
			kind: 'budget',
			expected: {max: workflow.maxTotalCalls},
			observed: calls.length,
			result: calls.length <= workflow.maxTotalCalls ? 'pass' : 'fail',
		}),
		assertionOf({
			id: 'budget.output-bytes',
			kind: 'budget',
			expected: {max: workflow.maxOutputBytes},
			observed: events.outputBytes,
			result: events.outputBytes <= workflow.maxOutputBytes ? 'pass' : 'fail',
		}),
		...limitAssertionsOf('budget.calls-by-family', workflow.maxCallsByFamily, (family) => familyCountOf(calls, family)),
		...limitAssertionsOf('budget.output-bytes-by-family', workflow.maxOutputBytesByFamily, (family) => events.familyBytes[family]),
		assertionOf({
			id: 'tools.required',
			kind: 'tools',
			expected: workflow.requiredTools,
			observed: missingTools,
			result: missingTools.length === 0 ? 'pass' : 'fail',
		}),
		assertionOf({
			id: 'tools.forbidden',
			kind: 'tools',
			expected: [],
			observed: forbidden,
			result: forbidden.length === 0 ? 'pass' : 'fail',
		}),
	];

	assertions.push(...optionalAssertionsOf(workflow, {firstRetrievalTool, broadSearches, duplicateReads, fallbacksAfterAuthoritative}, durationMs, events));

	const result = resultOf(assertions);

	return {
		result,
		compliant: result === 'pass',
		violations: violationsOf(assertions),
		assertions,
		broadSearches,
		duplicateReads,
		fallbacksAfterAuthoritative,
		firstRetrievalTool,
	};
};
