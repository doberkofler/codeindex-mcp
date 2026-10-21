import assert from 'node:assert/strict';
import test from 'node:test';
import {TOOL_FAMILIES, type RunEventsType, type ToolCallType, type ToolFamilyType} from './events.ts';
import {caseOf, type CaseType} from './schema.ts';
import {isBroadSearch, workflowOf} from './workflow.ts';

type CallInputType = Readonly<{
	tool: string;
	family: ToolFamilyType;
	input?: Record<string, unknown>;
	status?: ToolCallType['status'];
	outputBytes?: number;
	index?: number;
}>;

const callOf = (input: CallInputType): ToolCallType => ({
	index: input.index ?? 1,
	rawIndex: input.index ?? 1,
	parentIndex: null,
	id: `call-${input.index ?? 1}`,
	tool: input.tool,
	family: input.family,
	status: input.status ?? 'completed',
	input: input.input ?? {},
	inputValid: true,
	inputText: JSON.stringify(input.input ?? {}),
	outputBytes: input.outputBytes ?? 0,
	durationMs: 1,
	error: null,
});

const eventsOf = (calls: readonly ToolCallType[]): RunEventsType => {
	const familyBytes = Object.fromEntries(TOOL_FAMILIES.map((family) => [family, 0])) as Record<ToolFamilyType, number>;

	for (const call of calls) {
		familyBytes[call.family] += call.outputBytes;
	}

	return {
		toolCalls: calls,
		events: [],
		malformed: [],
		truncated: false,
		rawEventCount: calls.length,
		steps: 1,
		finalText: '',
		telemetry: {
			inputTokens: {value: null, state: 'unavailable', unit: 'tokens', source: 'step_finish'},
			outputTokens: {value: null, state: 'unavailable', unit: 'tokens', source: 'step_finish'},
			reasoningTokens: {value: null, state: 'unavailable', unit: 'tokens', source: 'step_finish'},
			cacheReadTokens: {value: null, state: 'unavailable', unit: 'tokens', source: 'step_finish.cache.read'},
			cacheWriteTokens: {value: null, state: 'unavailable', unit: 'tokens', source: 'step_finish.cache.write'},
			reportedCost: {value: null, state: 'unavailable', unit: 'usd', source: 'step_finish.cost'},
		},
		usage: {input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, available: false},
		errors: [],
		outputBytes: calls.reduce((total, call) => total + call.outputBytes, 0),
		familyBytes,
	};
};

const caseOfWorkflow = (workflow: Record<string, unknown>): CaseType =>
	caseOf({
		schemaVersion: 1,
		id: 'case-a',
		title: 'Case A',
		class: 'locate',
		tags: ['locate'],
		prompt: 'Which file defines A?',
		scope: ['src/**'],
		expectedFiles: ['src/a.ts'],
		contextFiles: [],
		forbiddenFiles: [],
		workflow: {maxTotalCalls: 12, requiredFirstTool: null, maxOutputBytes: 1_000, ...workflow},
		timeoutMs: 1_000,
	});

const call = (tool: string, family: ToolFamilyType, input: Record<string, unknown> = {}, index = 1, outputBytes = 0): ToolCallType =>
	callOf({tool, family, input, index, outputBytes});

const assertion = (testCase: CaseType, calls: readonly ToolCallType[], id: string, durationMs = 100) =>
	workflowOf(testCase, eventsOf(calls), durationMs).assertions.find((item) => item.id === id);

test('total-call and output-byte budgets pass exactly at the boundary and fail one over', () => {
	const calls = [call('read', 'read', {path: 'src/a.ts'}, 1, 7), call('read', 'read', {path: 'src/b.ts'}, 2, 7)];

	assert.equal(assertion(caseOfWorkflow({maxTotalCalls: 2, maxOutputBytes: 14}), calls, 'budget.total-calls')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({maxTotalCalls: 2, maxOutputBytes: 14}), calls, 'budget.output-bytes')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({maxTotalCalls: 1, maxOutputBytes: 14}), calls, 'budget.total-calls')?.result, 'fail');
	assert.equal(assertion(caseOfWorkflow({maxTotalCalls: 2, maxOutputBytes: 13}), calls, 'budget.output-bytes')?.result, 'fail');
});

test('per-family call and output budgets apply independently', () => {
	const calls = [
		call('grep', 'search', {pattern: 'x', path: 'src'}, 1, 5),
		call('grep', 'search', {pattern: 'y', path: 'src'}, 2, 5),
		call('read', 'read', {path: 'src/a.ts'}, 3, 9),
	];
	const testCase = caseOfWorkflow({
		maxCallsByFamily: {search: 2, read: 1},
		maxOutputBytesByFamily: {search: 10, read: 8},
	});

	assert.equal(assertion(testCase, calls, 'budget.calls-by-family.search')?.result, 'pass');
	assert.equal(assertion(testCase, calls, 'budget.calls-by-family.read')?.result, 'pass');
	assert.equal(assertion(testCase, calls, 'budget.output-bytes-by-family.search')?.result, 'pass');
	assert.equal(assertion(testCase, calls, 'budget.output-bytes-by-family.read')?.result, 'fail');
});

test('required and forbidden tools are exact tool names', () => {
	const calls = [call('grep', 'search', {path: 'src'})];

	assert.equal(assertion(caseOfWorkflow({requiredTools: ['grep']}), calls, 'tools.required')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({requiredTools: ['read']}), calls, 'tools.required')?.result, 'fail');
	assert.equal(assertion(caseOfWorkflow({forbiddenTools: ['read']}), calls, 'tools.forbidden')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({forbiddenTools: ['grep']}), calls, 'tools.forbidden')?.result, 'fail');
});

test('first retrieval tool ignores non-retrieval calls before it', () => {
	const calls = [call('bash', 'execute', {command: 'pwd'}, 1), call('grep', 'search', {path: 'src'}, 2)];

	assert.equal(assertion(caseOfWorkflow({requiredFirstTool: 'grep'}), calls, 'tools.first-retrieval')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({requiredFirstTool: 'read'}), calls, 'tools.first-retrieval')?.result, 'fail');
	assert.equal(assertion(caseOfWorkflow({requiredFirstTool: 'grep'}), [call('bash', 'execute', {command: 'pwd'})], 'tools.first-retrieval')?.result, 'fail');
});

test('duplicate reads compare the exact validated read range', () => {
	const duplicate = [
		call('read', 'read', {filePath: 'src/a.ts', offset: 10, limit: 20}, 1),
		call('read', 'read', {limit: 20, offset: 10, filePath: 'src/a.ts'}, 2),
	];
	const distinct = [
		call('read', 'read', {filePath: 'src/a.ts', offset: 10, limit: 20}, 1),
		call('read', 'read', {filePath: 'src/a.ts', offset: 30, limit: 20}, 2),
	];

	assert.equal(assertion(caseOfWorkflow({maxDuplicateReads: 1}), duplicate, 'reads.duplicate')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({maxDuplicateReads: 0}), duplicate, 'reads.duplicate')?.result, 'fail');
	assert.equal(assertion(caseOfWorkflow({maxDuplicateReads: 0}), distinct, 'reads.duplicate')?.result, 'pass');
});

test('fallback after an authoritative index result is measured, not assumed', () => {
	const afterSuccess = [call('codeindex_find_symbol', 'index', {query: 'A'}, 1, 20), call('read', 'read', {path: 'src/a.ts'}, 2, 5)];
	const beforeSuccess = [call('read', 'read', {path: 'src/a.ts'}, 1, 5), call('codeindex_find_symbol', 'index', {query: 'A'}, 2, 20)];
	const failedIndex = [
		callOf({tool: 'codeindex_find_symbol', family: 'index', input: {query: 'A'}, status: 'error', index: 1, outputBytes: 0}),
		call('read', 'read', {path: 'src/a.ts'}, 2, 5),
	];

	assert.equal(assertion(caseOfWorkflow({maxFallbacksAfterAuthoritative: 1}), afterSuccess, 'routing.fallback-after-authoritative')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({maxFallbacksAfterAuthoritative: 0}), afterSuccess, 'routing.fallback-after-authoritative')?.result, 'fail');
	assert.equal(assertion(caseOfWorkflow({maxFallbacksAfterAuthoritative: 0}), beforeSuccess, 'routing.fallback-after-authoritative')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({maxFallbacksAfterAuthoritative: 0}), failedIndex, 'routing.fallback-after-authoritative')?.result, 'pass');
});

test('broad-search classification is structural and ignores query text', () => {
	const broad = [
		call('grep', 'search', {pattern: 'unique-literal'}),
		call('grep', 'search', {pattern: 'unique-literal', path: '.'}),
		call('grep', 'search', {pattern: 'unique-literal', path: '**'}),
		call('glob', 'search', {pattern: '**/*.ts'}),
	];
	const bounded = [
		call('grep', 'search', {pattern: 'x', path: 'src'}),
		call('grep', 'search', {pattern: 'x', path: 'src/core/**'}),
		call('grep', 'search', {pattern: 'x', path: 'src', include: '**/*.ts'}),
		call('grep', 'search', {pattern: 'x', path: '.', include: 'src/**/*.ts'}),
		call('glob', 'search', {pattern: 'src/**/*.ts'}),
		call('read', 'read', {path: 'src/a.ts'}),
	];

	for (const item of broad) {
		assert.equal(isBroadSearch(item), true, item.tool);
	}

	for (const item of bounded) {
		assert.equal(isBroadSearch(item), false, `${item.tool} ${JSON.stringify(item.input)}`);
	}

	const calls = [call('grep', 'search', {path: 'src'}, 1), call('grep', 'search', {pattern: 'x'}, 2), call('grep', 'search', {path: '.'}, 3)];

	assert.equal(assertion(caseOfWorkflow({maxBroadSearches: 2}), calls, 'search.broad')?.result, 'pass');
	assert.equal(assertion(caseOfWorkflow({maxBroadSearches: 1}), calls, 'search.broad')?.result, 'fail');
});

test('wall-clock budgets and exact token budgets are separate from correctness', () => {
	const calls = [call('read', 'read', {path: 'src/a.ts'})];
	const durationCase = caseOfWorkflow({maxDurationMs: 100});

	assert.equal(assertion(durationCase, calls, 'time.max-duration', 100)?.result, 'pass');
	assert.equal(assertion(durationCase, calls, 'time.max-duration', 101)?.result, 'fail');

	const events = eventsOf(calls);
	const exact = {
		...events,
		telemetry: {
			...events.telemetry,
			inputTokens: {value: 10, state: 'exact', unit: 'tokens', source: 'step_finish'},
			outputTokens: {value: 5, state: 'exact', unit: 'tokens', source: 'step_finish'},
			reasoningTokens: {value: 2, state: 'exact', unit: 'tokens', source: 'step_finish'},
		},
	} as const;

	assert.equal(workflowOf(caseOfWorkflow({maxTokens: 17}), exact, 10).assertions.find((item) => item.id === 'tokens.uncached')?.result, 'pass');
	assert.equal(workflowOf(caseOfWorkflow({maxTokens: 16}), exact, 10).assertions.find((item) => item.id === 'tokens.uncached')?.result, 'fail');
	assert.equal(workflowOf(caseOfWorkflow({maxTokens: 0}), events, 10).result, 'unevaluated');
	assert.equal(workflowOf(caseOfWorkflow({maxTokens: 0}), events, 10).compliant, false);
});

test('workflow results remain independent from correctness and keep every failed predicate', () => {
	const testCase = caseOfWorkflow({maxTotalCalls: 1, requiredTools: ['grep'], forbiddenTools: ['read']});
	const result = workflowOf(testCase, eventsOf([call('read', 'read', {path: 'src/a.ts'}), call('read', 'read', {path: 'src/b.ts'})]), 10);

	assert.equal(result.result, 'fail');
	assert.equal(result.compliant, false);
	assert.ok(result.violations.length >= 3);
	assert.equal(result.assertions.find((item) => item.id === 'budget.total-calls')?.result, 'fail');
	assert.equal(result.assertions.find((item) => item.id === 'tools.required')?.result, 'fail');
	assert.equal(result.assertions.find((item) => item.id === 'tools.forbidden')?.result, 'fail');
});
