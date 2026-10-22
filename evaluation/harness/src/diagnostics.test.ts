import assert from 'node:assert/strict';
import test from 'node:test';
import {diagnosticReportOf, diagnosticSummaryOf} from './diagnostics.ts';
import {type ExecutionIdentityType} from './identity.ts';
import {type RunResultType} from './runner.ts';

const identity: ExecutionIdentityType = {
	harness: {schemaVersion: '1.0', version: 1},
	suite: {id: 'suite', version: 2, hash: 'a'.repeat(64)},
	case: {id: 'case-a', hash: 'b'.repeat(64), promptHash: 'c'.repeat(64), timeoutMs: 5_000},
	model: {
		provider: 'provider',
		modelId: 'model',
		digest: 'd'.repeat(64),
		quantization: null,
		runtime: null,
		runtimeVersion: null,
		generationSettingsDigest: 'e'.repeat(64),
	},
	agent: {
		id: 'evaluator',
		version: '1',
		instructionsHash: 'f'.repeat(64),
		toolListHash: '1'.repeat(64),
		permissionsHash: '2'.repeat(64),
		contextBudgetTokens: 0,
	},
	treatment: {id: 'no-index', kind: 'no-index', definitionHash: '3'.repeat(64), mcpSurfaceHash: '4'.repeat(64)},
	subject: {
		revision: 'abc1234',
		isolationMode: 'detached-worktree',
		contentManifestHash: '5'.repeat(64),
		projectFilesHash: '5'.repeat(64),
		lockFileHash: null,
		externalFixtureHash: null,
	},
	artifacts: {accepted: null, candidate: null},
	codeIndex: {configDigest: '6'.repeat(64)},
	repetitionIndex: 1,
	randomizationSeed: '7'.repeat(64),
};

const runOf = (overrides: Partial<RunResultType> = {}): RunResultType => ({
	recordType: 'result',
	schemaVersion: '1.0',
	campaignId: 'campaign',
	identity,
	identityDigest: '8'.repeat(64),
	attempt: 1,
	caseId: 'impact-a',
	caseClass: 'impact',
	treatment: 'no-index',
	treatmentDefinitionHash: '9'.repeat(64),
	repetition: 1,
	model: 'provider/model',
	revision: 'abc1234',
	startedAt: '2026-10-22T00:00:00.000Z',
	completedAt: '2026-10-22T00:00:10.000Z',
	durationMs: 10_000,
	exitCode: 0,
	signal: null,
	timedOut: false,
	timeoutMs: 180_000,
	outcome: 'completed',
	defects: [],
	isolation: {mode: 'detached-worktree', clientStore: 'ephemeral', checkoutClean: true, revisionMatch: true, restored: true},
	artifacts: {accepted: null, candidate: null, loaded: null},
	usage: {available: true, input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0},
	telemetry: {
		inputTokens: {value: 10, state: 'exact', unit: 'tokens', source: 'step_finish'},
		outputTokens: {value: 5, state: 'exact', unit: 'tokens', source: 'step_finish'},
		reasoningTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'step_finish'},
		cacheReadTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'step_finish'},
		cacheWriteTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'step_finish'},
		reportedCost: {value: 0, state: 'exact', unit: 'usd', source: 'step_finish'},
	},
	toolCalls: [],
	outputBytes: 0,
	familyBytes: {index: 0, search: 0, read: 0, list: 0, write: 0, execute: 0, task: 0, other: 0},
	rawEventCount: 2,
	malformedEventCount: 0,
	streamTruncated: false,
	indexCalls: 0,
	surface: {
		treatmentId: 'no-index',
		ordinary: ['bash', 'edit', 'glob', 'grep', 'list', 'read'],
		codeIndex: [],
		execute: 'absent',
		tools: ['bash', 'edit', 'glob', 'grep', 'list', 'read'],
		callable: ['bash', 'edit', 'glob', 'grep', 'list', 'patch', 'read', 'shell', 'write'],
		native: true,
		digest: 'a'.repeat(64),
	},
	routing: {ordinaryCalls: 1, codeIndexCalls: 0, executeCalls: 0, unknownTools: [], native: true},
	errors: [],
	grade: {
		parsed: true,
		files: ['src/a.ts'],
		absent: false,
		success: true,
		missing: [],
		forbidden: [],
		extra: [],
		falseAbsence: false,
		reason: 'all expected files named',
		result: 'pass',
		assertions: [],
	},
	workflow: {
		result: 'pass',
		compliant: true,
		violations: [],
		assertions: [],
		broadSearches: [],
		duplicateReads: 0,
		fallbacksAfterAuthoritative: 0,
		firstRetrievalTool: 'read',
	},
	postRun: null,
	valid: true,
	invalidReason: null,
	rateLimited: false,
	attempts: [
		{
			attempt: 1,
			startedAt: '2026-10-22T00:00:00.000Z',
			durationMs: 10_000,
			exitCode: 0,
			signal: null,
			timedOut: false,
			rateLimited: false,
			invalidReason: null,
			rawFile: null,
		},
	],
	finalText: '{"files":["src/a.ts"],"absent":false}',
	stderrTail: '',
	...overrides,
});

test('clean diagnostic executions pass the contract', () => {
	const report = diagnosticReportOf([runOf(), runOf({caseId: 'impl-a', treatment: 'accepted'})]);

	assert.equal(report.executions, 2);
	assert.equal(report.validExecutions, 2);
	assert.equal(report.passed, true);
	assert.deepEqual(report.blocking, []);
	assert.equal(diagnosticSummaryOf(report), '2 diagnostic execution(s), no contract anomaly');
});

test('inherited edits, undeclared tools, and retries are harness anomalies', () => {
	const report = diagnosticReportOf([
		runOf({isolation: {mode: 'detached-worktree', clientStore: 'ephemeral', checkoutClean: false, revisionMatch: true, restored: true}}),
		runOf({routing: {ordinaryCalls: 1, codeIndexCalls: 0, executeCalls: 0, unknownTools: ['write'], native: true}}),
		runOf({attempts: [runOf().attempts[0]!, runOf().attempts[0]!]}),
	]);

	assert.equal(report.passed, false);
	assert.deepEqual(
		report.blocking.map((anomaly) => anomaly.kind),
		['dirty-checkout', 'unknown-tool', 'retried'],
	);
	assert.deepEqual(new Set(report.blocking.map((anomaly) => anomaly.attribution)), new Set(['harness']));
});

test('missing structured answers and wrong answers belong to the model', () => {
	const report = diagnosticReportOf([
		runOf({grade: {...runOf().grade, parsed: false, success: false, reason: 'no JSON object'}}),
		runOf({grade: {...runOf().grade, success: false, missing: ['src/a.ts'], reason: 'missing expected file'}}),
	]);

	assert.equal(report.passed, false);
	assert.deepEqual(
		report.blocking.map((anomaly) => anomaly.kind),
		['unstructured-answer'],
	);
	assert.deepEqual(
		report.anomalies.map((anomaly) => [anomaly.kind, anomaly.attribution]),
		[
			['unstructured-answer', 'model'],
			['correctness-failed', 'model'],
		],
	);
});

test('an invalid model tool argument is a model anomaly, not a CodeIndex defect', () => {
	const report = diagnosticReportOf([
		runOf({
			toolCalls: [
				{
					index: 1,
					rawIndex: 1,
					parentIndex: null,
					id: 'call-1',
					tool: 'codeindex_find_symbol',
					family: 'index',
					status: 'error',
					input: {query: 'SCHEMA_VERSION', context: 'codeindex'},
					inputValid: true,
					inputText: '{}',
					outputBytes: 0,
					authoritative: null,
					durationMs: 1,
					error: '{"ok":false,"error":{"code":"invalid_argument","message":"Unknown project context: codeindex"}}',
				},
			],
		}),
	]);

	assert.equal(report.passed, true);
	assert.deepEqual(
		report.anomalies.map((anomaly) => [anomaly.kind, anomaly.attribution]),
		[['invalid-tool-input', 'model']],
	);
});

test('process, index, and timeout failures keep separate owners', () => {
	const report = diagnosticReportOf([
		runOf({outcome: 'failed', valid: false, exitCode: 3, invalidReason: 'agent exited with 3'}),
		runOf({
			toolCalls: [
				{
					index: 1,
					rawIndex: 1,
					parentIndex: null,
					id: 'call-1',
					tool: 'codeindex_find_symbol',
					family: 'index',
					status: 'error',
					input: {},
					inputValid: true,
					inputText: '{}',
					outputBytes: 0,
					authoritative: null,
					durationMs: 1,
					error: '{"ok":false,"error":{"code":"index_not_ready","message":"index not ready"}}',
				},
			],
		}),
		runOf({outcome: 'timed-out', valid: false, timedOut: true, exitCode: null, timeoutMs: 180_000}),
	]);

	assert.deepEqual(
		report.anomalies.map((anomaly) => [anomaly.kind, anomaly.attribution]),
		[
			['process-failed', 'integration'],
			['codeindex-error', 'codeindex'],
			['timed-out', 'model'],
		],
	);
	assert.deepEqual(
		report.blocking.map((anomaly) => anomaly.kind),
		['process-failed', 'timed-out'],
	);
});
