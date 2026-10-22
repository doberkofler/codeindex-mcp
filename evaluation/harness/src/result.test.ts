import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {executionIdentityDigestOf, type ExecutionIdentityType} from './identity.ts';
import {effectiveValidityOf, readResult, resultPathOf, resumeStateOf, writeResult} from './result.ts';
import {type RunResultType} from './runTypes.ts';
import {toolSurfaceOf, treatmentOf} from './treatment.ts';

const identityOf = (promptHash = 'c'.repeat(64)): ExecutionIdentityType => ({
	harness: {schemaVersion: '1.0', version: 1},
	suite: {id: 'suite', version: 1, hash: 'a'.repeat(64)},
	case: {id: 'case-a', hash: 'b'.repeat(64), promptHash, timeoutMs: 5000},
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
});

const treatment = treatmentOf({
	id: 'no-index',
	kind: 'no-index',
	ordinaryTools: ['bash', 'glob', 'grep', 'list', 'read'],
	codeMode: 'absent',
	artifact: null,
	mcp: null,
});

const resultOf = (overrides: Partial<RunResultType> = {}, promptHash?: string): RunResultType => {
	const identity = identityOf(promptHash);
	const telemetry = {value: null, state: 'unavailable', unit: 'tokens', source: 'unused'} as const;

	return {
		recordType: 'result',
		schemaVersion: '1.0',
		campaignId: 'campaign',
		identity,
		identityDigest: executionIdentityDigestOf(identity),
		attempt: 1,
		caseId: 'case-a',
		caseClass: 'locate',
		treatment: 'no-index',
		treatmentDefinitionHash: treatment.definitionHash,
		repetition: 1,
		model: 'provider/model',
		revision: 'abc1234',
		startedAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:01.000Z',
		durationMs: 1000,
		exitCode: 0,
		signal: null,
		timedOut: false,
		timeoutMs: 5000,
		outcome: 'completed',
		defects: [],
		isolation: {mode: 'detached-worktree', clientStore: 'ephemeral', checkoutClean: true, revisionMatch: true, restored: true},
		artifacts: {accepted: null, candidate: null, loaded: null},
		usage: {input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, available: true},
		telemetry: {
			inputTokens: telemetry,
			outputTokens: telemetry,
			reasoningTokens: telemetry,
			cacheReadTokens: telemetry,
			cacheWriteTokens: telemetry,
			reportedCost: {...telemetry, unit: 'usd'},
		},
		toolCalls: [],
		outputBytes: 0,
		familyBytes: {index: 0, search: 0, read: 0, list: 0, write: 0, execute: 0, task: 0, other: 0},
		rawEventCount: 0,
		malformedEventCount: 0,
		streamTruncated: false,
		indexCalls: 0,
		surface: toolSurfaceOf(treatment),
		routing: {ordinaryCalls: 0, codeIndexCalls: 0, executeCalls: 0, unknownTools: [], native: true},
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
			firstRetrievalTool: null,
		},
		postRun: null,
		valid: true,
		invalidReason: null,
		rateLimited: false,
		attempts: [],
		finalText: '{"files":["src/a.ts"],"absent":false}',
		stderrTail: '',
		...overrides,
	};
};

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-result-'));
	testContext.after(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

void test('a result is written atomically, verified, and never overwritten', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const file = resultPathOf(root, 1);
	const stored = writeResult(file, resultOf());

	assert.deepEqual(readdirSync(root), ['attempt-1.json']);
	assert.deepEqual(readResult(file), stored);
	assert.match(stored.integrity.contentDigest, /^[0-9a-f]{64}$/u);
	assert.equal(Number.isInteger(stored.integrity.sizeBytes), true);
	assert.throws(() => writeResult(file, resultOf()), /refusing to overwrite/u);
	assert.throws(() => writeResult(resultPathOf(root, 2), resultOf({identityDigest: '0'.repeat(64)})), /identity digest does not match/u);
});

void test('partial, truncated, and tampered records are not results', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const file = resultPathOf(root, 1);
	const stored = writeResult(file, resultOf());
	const text = readFileSync(file, 'utf8');

	writeFileSync(file, text.slice(0, Math.floor(text.length / 2)), 'utf8');
	assert.equal(readResult(file), null);

	writeFileSync(file, text, 'utf8');
	assert.notEqual(readResult(file), null);

	const tampered = {...stored, outcome: 'failed'};
	writeFileSync(file, `${JSON.stringify(tampered, null, '\t')}\n`, 'utf8');
	assert.equal(readResult(file), null);
});

void test('resume reuses only a complete, effective result with the same identity', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const identityDigest = executionIdentityDigestOf(identityOf());

	assert.deepEqual(resumeStateOf(root, identityDigest), {record: null, attempt: null, nextAttempt: 1});

	const first = writeResult(resultPathOf(root, 1), resultOf());
	assert.deepEqual(resumeStateOf(root, identityDigest), {record: first, attempt: 1, nextAttempt: 2});

	const different = writeResult(resultPathOf(root, 2), resultOf({}, '0'.repeat(64)));
	assert.equal(different.identityDigest === identityDigest, false);
	assert.deepEqual(resumeStateOf(root, identityDigest), {record: first, attempt: 1, nextAttempt: 3});

	const aborted = writeResult(resultPathOf(root, 3), resultOf({attempt: 3, outcome: 'aborted'}));
	assert.equal(effectiveValidityOf(aborted), 'aborted');
	assert.deepEqual(resumeStateOf(root, identityDigest), {record: null, attempt: null, nextAttempt: 4});
});

void test('a corrupt later attempt is ignored and a failed or timed-out attempt satisfies its slot', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const identityDigest = executionIdentityDigestOf(identityOf());
	const failed = writeResult(resultPathOf(root, 1), resultOf({outcome: 'failed', valid: false, exitCode: 1}));

	writeFileSync(resultPathOf(root, 2), '{"recordType":"result"', 'utf8');

	assert.deepEqual(resumeStateOf(root, identityDigest), {record: failed, attempt: 1, nextAttempt: 3});
	assert.equal(effectiveValidityOf(failed), 'valid');

	const timedOut = writeResult(resultPathOf(root, 3), resultOf({attempt: 3, outcome: 'timed-out', timedOut: true, exitCode: null, valid: false}));
	assert.equal(effectiveValidityOf(timedOut), 'valid');
});
