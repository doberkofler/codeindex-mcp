import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {executionIdentityDigestOf, type ExecutionIdentityType} from './identity.ts';
import {clientStoreOf, type ClientStoreType} from './isolation.ts';
import {readResult, writeResult} from './result.ts';
import {runOnce, withRestoration} from './runner.ts';
import {caseOf, type CaseType} from './schema.ts';
import {toolSurfaceOf, treatmentOf, type TreatmentDefinitionType} from './treatment.ts';

const NO_RETRY = {maxAttempts: 1, backoffMs: () => 0};

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-runner-'));
	testContext.after(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const scriptOf = (root: string, name: string, body: string): string => {
	const file = path.join(root, `${name}.sh`);
	writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, 'utf8');
	chmodSync(file, 0o755);

	return file;
};

const testCaseOf = (overrides: Record<string, unknown> = {}): CaseType =>
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
		workflow: {maxTotalCalls: 12, requiredFirstTool: null, maxOutputBytes: 1_000},
		timeoutMs: 5_000,
		...overrides,
	});

const treatment: TreatmentDefinitionType = treatmentOf({
	id: 'no-index',
	kind: 'no-index',
	ordinaryTools: ['bash', 'glob', 'grep', 'list', 'read'],
	codeMode: 'absent',
	artifact: null,
	mcp: null,
});

const identity: ExecutionIdentityType = {
	harness: {schemaVersion: '1.0', version: 1},
	suite: {id: 'suite', version: 1, hash: 'a'.repeat(64)},
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

const clientStore = (root: string): ClientStoreType =>
	clientStoreOf({
		campaignStore: null,
		campaignDir: path.join(root, 'campaign'),
		environment: {XDG_DATA_HOME: path.join(root, 'data')},
		homeDirectory: path.join(root, 'home'),
	});

const execute = (root: string, command: string, testCase: CaseType, store: ClientStoreType = clientStore(root)) =>
	runOnce({
		cwd: root,
		testCase,
		treatment,
		surface: toolSurfaceOf(treatment),
		repetition: 1,
		model: 'provider/model',
		revision: 'abc1234',
		campaignId: 'campaign',
		identity,
		identityDigest: executionIdentityDigestOf(identity),
		clientStore: store,
		isolation: {
			mode: 'detached-worktree',
			clientStore: store.mode,
			checkoutClean: true,
			revisionMatch: true,
		},
		artifacts: {accepted: null, candidate: null, loaded: null},
		rawBase: path.join(root, 'raw', 'case-a'),
		command,
		retry: NO_RETRY,
	});

test('a successful execution uses a standalone private in-memory server', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const witness = path.join(root, 'witness');
	mkdirSync(witness, {recursive: true});
	const command = scriptOf(
		root,
		'success',
		[
			`printf '%s\\n' "$OPENCODE_DB" > ${quote(path.join(witness, 'db.txt'))}`,
			`printf '%s\\n' "$@" > ${quote(path.join(witness, 'args.txt'))}`,
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);

	const result = await execute(root, command, testCaseOf());
	const args = readFileSync(path.join(witness, 'args.txt'), 'utf8').split('\n');

	assert.equal(result.outcome, 'completed');
	assert.equal(result.valid, true);
	assert.equal(result.exitCode, 0);
	assert.equal(result.timedOut, false);
	assert.deepEqual(result.isolation, {
		mode: 'detached-worktree',
		clientStore: 'ephemeral',
		checkoutClean: true,
		revisionMatch: true,
		restored: false,
	});
	assert.deepEqual(result.artifacts, {accepted: null, candidate: null, loaded: null});
	assert.equal(result.grade.success, true);
	assert.equal(readFileSync(path.join(witness, 'db.txt'), 'utf8').trim(), ':memory:');
	assert.equal(args.includes('--standalone'), true);
	assert.equal(args.includes('--continue'), false);
	assert.equal(args.includes('--session'), false);
	assert.equal(args.includes('--fork'), false);
});

test('every repetition starts with no inherited session and no default database write', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const witness = path.join(root, 'witness');
	const dataDirectory = path.join(root, 'data', 'opencode');
	mkdirSync(witness, {recursive: true});
	mkdirSync(dataDirectory, {recursive: true});
	const defaultDatabase = path.join(dataDirectory, 'opencode.db');
	writeFileSync(defaultDatabase, 'operator-session-store', 'utf8');
	const command = scriptOf(
		root,
		'repetition',
		[
			`count=$(cat ${quote(path.join(witness, 'count'))} 2>/dev/null || printf 0)`,
			`count=$((count + 1))`,
			`printf '%s' "$count" > ${quote(path.join(witness, 'count'))}`,
			`printf '%s\\n' "$OPENCODE_DB" > ${quote(path.join(witness, 'db'))}-$count.txt`,
			`printf '%s\\n' "$@" > ${quote(path.join(witness, 'args'))}-$count.txt`,
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);
	const previous = process.env['XDG_DATA_HOME'];
	process.env['XDG_DATA_HOME'] = path.join(root, 'data');

	try {
		const first = await execute(root, command, testCaseOf());
		const second = await execute(root, command, testCaseOf());

		assert.equal(first.valid, true);
		assert.equal(second.valid, true);

		for (const attempt of [1, 2] as const) {
			const args = readFileSync(path.join(witness, `args-${attempt}.txt`), 'utf8').split('\n');

			assert.equal(readFileSync(path.join(witness, `db-${attempt}.txt`), 'utf8').trim(), ':memory:');
			assert.equal(args.includes('--standalone'), true);
			assert.equal(args.includes('--continue'), false);
			assert.equal(args.includes('--session'), false);
			assert.equal(args.includes('--fork'), false);
		}

		assert.equal(readFileSync(defaultDatabase, 'utf8'), 'operator-session-store');
		assert.deepEqual(existsSync(path.join(dataDirectory, 'opencode.db-wal')), false);
		assert.deepEqual(existsSync(path.join(root, 'campaign')), false);
	} finally {
		if (previous === undefined) {
			delete process.env['XDG_DATA_HOME'];
		} else {
			process.env['XDG_DATA_HOME'] = previous;
		}
	}
});

test('successful, failed, and timed-out executions leave the normal database unchanged', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const dataDirectory = path.join(root, 'data', 'opencode');
	mkdirSync(dataDirectory, {recursive: true});
	const defaultDatabase = path.join(dataDirectory, 'opencode.db');
	writeFileSync(defaultDatabase, 'operator-session-store', 'utf8');
	const success = scriptOf(
		root,
		'success',
		[
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);
	const failure = scriptOf(
		root,
		'failure',
		["cat <<'EVENTS'", String.raw`{"type":"error","error":{"type":"provider.no-route","message":"boom"}}`, 'EVENTS', 'exit 3'].join('\n'),
	);
	const timeout = scriptOf(root, 'timeout', 'sleep 30');
	const previous = process.env['XDG_DATA_HOME'];
	process.env['XDG_DATA_HOME'] = path.join(root, 'data');

	try {
		const outcomes = [
			(await execute(root, success, testCaseOf())).outcome,
			(await execute(root, failure, testCaseOf())).outcome,
			(await execute(root, timeout, testCaseOf({timeoutMs: 150}))).outcome,
		];

		assert.deepEqual(outcomes, ['completed', 'failed', 'timed-out']);
		assert.equal(readFileSync(defaultDatabase, 'utf8'), 'operator-session-store');
		assert.deepEqual(existsSync(path.join(dataDirectory, 'opencode.db-wal')), false);
		assert.deepEqual(existsSync(path.join(dataDirectory, 'opencode.db-shm')), false);
	} finally {
		if (previous === undefined) {
			delete process.env['XDG_DATA_HOME'];
		} else {
			process.env['XDG_DATA_HOME'] = previous;
		}
	}
});

test('a campaign-local store never resumes a session from a prior repetition', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const witness = path.join(root, 'witness');
	const dataDirectory = path.join(root, 'data', 'opencode');
	mkdirSync(witness, {recursive: true});
	mkdirSync(dataDirectory, {recursive: true});
	const defaultDatabase = path.join(dataDirectory, 'opencode.db');
	writeFileSync(defaultDatabase, 'operator-session-store', 'utf8');
	const store = clientStoreOf({
		campaignStore: path.join(root, 'campaign', 'client.db'),
		campaignDir: path.join(root, 'campaign'),
		environment: {XDG_DATA_HOME: path.join(root, 'data')},
		homeDirectory: path.join(root, 'home'),
	});
	const command = scriptOf(
		root,
		'campaign',
		[
			`printf '%s\\n' "$OPENCODE_DB" >> ${quote(path.join(witness, 'db.txt'))}`,
			`printf '%s\\n' "$@" >> ${quote(path.join(witness, 'args.txt'))}`,
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);
	const previous = process.env['XDG_DATA_HOME'];
	process.env['XDG_DATA_HOME'] = path.join(root, 'data');

	try {
		const first = await execute(root, command, testCaseOf(), store);
		const second = await execute(root, command, testCaseOf(), store);

		assert.equal(first.valid, true);
		assert.equal(second.valid, true);
		assert.deepEqual(readFileSync(path.join(witness, 'db.txt'), 'utf8').trim().split('\n'), [store.path, store.path]);

		const args = readFileSync(path.join(witness, 'args.txt'), 'utf8').split('\n');

		assert.equal(args.filter((arg) => arg === '--standalone').length, 2);
		assert.equal(args.includes('--continue'), false);
		assert.equal(args.includes('--session'), false);
		assert.equal(args.includes('--fork'), false);
		assert.equal(readFileSync(defaultDatabase, 'utf8'), 'operator-session-store');
	} finally {
		if (previous === undefined) {
			delete process.env['XDG_DATA_HOME'];
		} else {
			process.env['XDG_DATA_HOME'] = previous;
		}
	}
});

test('a campaign-local store path is passed instead of the default database', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const witness = path.join(root, 'witness');
	mkdirSync(witness, {recursive: true});
	const store = clientStoreOf({
		campaignStore: path.join(root, 'campaign', 'client.db'),
		campaignDir: path.join(root, 'campaign'),
		environment: {XDG_DATA_HOME: path.join(root, 'data')},
		homeDirectory: path.join(root, 'home'),
	});
	const command = scriptOf(
		root,
		'campaign',
		[
			`printf '%s\\n' "$OPENCODE_DB" > ${quote(path.join(witness, 'db.txt'))}`,
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);

	const result = await execute(root, command, testCaseOf(), store);

	assert.equal(result.isolation.clientStore, 'campaign-local');
	assert.equal(readFileSync(path.join(witness, 'db.txt'), 'utf8').trim(), store.path);
	assert.notEqual(store.path, path.join(root, 'data', 'opencode', 'opencode.db'));
});

test('a failed execution is persisted as an inspectable failed result', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'failed',
		["cat <<'EVENTS'", String.raw`{"type":"error","error":{"type":"provider.no-route","message":"boom"}}`, 'EVENTS', 'exit 3'].join('\n'),
	);

	const result = await execute(root, command, testCaseOf());
	const file = path.join(root, 'results', 'rep-1.json');

	writeResult(file, result);

	const stored = readResult(file);

	assert.equal(result.outcome, 'failed');
	assert.equal(result.valid, false);
	assert.equal(result.exitCode, 3);
	assert.equal(result.invalidReason, 'agent exited with 3');
	assert.notEqual(stored, null);
	assert.equal(stored?.outcome, 'failed');
	assert.equal(stored?.exitCode, 3);
	assert.equal(stored?.valid, false);
	assert.match(stored?.integrity.contentDigest ?? '', /^[0-9a-f]{64}$/);
});

test('a hard timeout terminates the whole process group and stays inspectable', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const grandchild = path.join(root, 'grandchild.txt');
	const command = scriptOf(
		root,
		'timed-out',
		[`node -e 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "alive"), 600)' ${quote(grandchild)} &`, 'sleep 30'].join('\n'),
	);

	const result = await execute(root, command, testCaseOf({timeoutMs: 150}));

	assert.equal(result.outcome, 'timed-out');
	assert.equal(result.timedOut, true);
	assert.equal(result.valid, false);
	assert.equal(result.exitCode, null);
	assert.equal(result.invalidReason, 'timed out');
	assert.equal(result.signal === 'SIGTERM' || result.signal === 'SIGKILL', true);
	assert.equal(result.durationMs < 4_000, true);
	assert.equal(result.attempts.length, 1);

	await new Promise<void>((resolve) => {
		setTimeout(resolve, 800);
	});

	assert.equal(existsSync(grandchild), false);

	const file = path.join(root, 'results', 'rep-1.json');
	writeResult(file, result);

	const stored = JSON.parse(readFileSync(file, 'utf8')) as {outcome: string; timedOut: boolean};

	assert.equal(stored.outcome, 'timed-out');
	assert.equal(stored.timedOut, true);
});

test('a descendant that escapes the process group cannot hold the harness open', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const pidFile = path.join(root, 'escaped.pid');
	const command = scriptOf(
		root,
		'escaped',
		[
			`node -e 'const {spawn} = require("node:child_process"); const child = spawn("sleep", ["10"], {detached: true, stdio: ["ignore", "inherit", "inherit"]}); child.unref(); require("node:fs").writeFileSync(process.argv[1], String(child.pid))' ${quote(pidFile)}`,
			'sleep 30',
		].join('\n'),
	);

	try {
		const result = await execute(root, command, testCaseOf({timeoutMs: 1_000}));

		assert.equal(result.outcome, 'timed-out');
		assert.equal(result.exitCode, null);
		assert.equal(result.signal === 'SIGTERM' || result.signal === 'SIGKILL', true);
		assert.equal(result.durationMs < 20_000, true);
	} finally {
		if (existsSync(pidFile)) {
			try {
				process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
			} catch {
				// The escaped descendant already exited.
			}
		}
	}
});

test('a restoration failure is persisted as an inspectable failed result', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'success',
		[
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);
	const execution = await execute(root, command, testCaseOf());
	const result = withRestoration(execution, {restored: false, reason: 'workspace .git is missing'});
	const file = path.join(root, 'results', 'rep-1.json');

	writeResult(file, result);

	const stored = readResult(file);

	assert.equal(execution.isolation.restored, false);
	assert.equal(result.outcome, 'failed');
	assert.equal(result.valid, false);
	assert.match(result.invalidReason ?? '', /restoration failed: workspace \.git is missing/);
	assert.equal(result.isolation.restored, false);
	assert.equal(result.attempts.length, 1);
	assert.equal(stored?.outcome, 'failed');
	assert.equal(stored?.valid, false);
	assert.deepEqual(stored?.defects, ['dirty-isolation']);
});

test('missing token usage invalidates only the token metrics', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'no-usage',
		["cat <<'EVENTS'", String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`, 'EVENTS'].join('\n'),
	);

	const result = await execute(root, command, testCaseOf());

	assert.equal(result.outcome, 'completed');
	assert.equal(result.valid, true);
	assert.equal(result.invalidReason, null);
	assert.equal(result.grade.success, true);
	assert.equal(result.usage.available, false);
	assert.equal(result.telemetry.inputTokens.state, 'unavailable');
	assert.equal(result.telemetry.outputTokens.state, 'unavailable');
	assert.equal(result.telemetry.reportedCost.state, 'unavailable');
	assert.equal(result.telemetry.inputTokens.value, null);
});

test('nested tool calls and malformed lines are retained in the stored result', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'nested',
		[
			"cat <<'EVENTS'",
			String.raw`{"type":"tool_use","part":{"type":"tool","callID":"call-1","tool":"grep","state":{"status":"completed","input":{"pattern":"x"},"output":"abcd","time":{"start":10,"end":25}},"parts":[{"type":"tool","callID":"call-2","tool":"read","state":{"status":"error","input":{"filePath":"src/a.ts"},"error":"denied","time":{"start":30,"end":33}}}]}}`,
			'not-json',
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":2,"write":0}},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);

	const result = await execute(root, command, testCaseOf());

	assert.equal(result.valid, true);
	assert.deepEqual(
		result.toolCalls.map((call) => [call.tool, call.status, call.parentIndex, call.durationMs, call.outputBytes]),
		[
			['grep', 'completed', null, 15, 4],
			['read', 'error', 1, 3, 6],
		],
	);
	assert.equal(result.outputBytes, 10);
	assert.deepEqual(result.familyBytes, {
		index: 0,
		search: 4,
		read: 6,
		list: 0,
		write: 0,
		execute: 0,
		task: 0,
		other: 0,
	});
	assert.equal(result.rawEventCount, 4);
	assert.equal(result.malformedEventCount, 1);
	assert.equal(result.streamTruncated, false);
	assert.deepEqual(result.telemetry.cacheReadTokens, {
		value: 2,
		state: 'exact',
		unit: 'tokens',
		source: 'step_finish.cache.read',
	});
});

test('a successful restoration keeps the execution outcome', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'success',
		[
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);
	const result = withRestoration(await execute(root, command, testCaseOf()), {restored: true, reason: null});

	assert.equal(result.outcome, 'completed');
	assert.equal(result.valid, true);
	assert.equal(result.isolation.restored, true);
});

test('a declared post-run check is reported separately from correctness and process success', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'success',
		[
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);
	const passing = await execute(root, command, testCaseOf({check: {command: process.execPath, args: ['-e', 'process.exit(0)']}}));
	const failing = await execute(root, command, testCaseOf({check: {command: process.execPath, args: ['-e', 'process.exit(4)']}}));

	assert.equal(passing.postRun?.result, 'pass');
	assert.equal(failing.postRun?.result, 'fail');
	assert.equal(failing.postRun?.exitCode, 4);
	assert.equal(failing.grade.success, true);
	assert.equal(failing.valid, true);
	assert.equal(failing.outcome, 'completed');
});

test('a workflow violation does not change answer correctness or process validity', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'one-call',
		[
			"cat <<'EVENTS'",
			String.raw`{"type":"tool_use","part":{"type":"tool","callID":"call-1","tool":"read","state":{"status":"completed","input":{"path":"src/a.ts"},"output":"abcd"}}}`,
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
		].join('\n'),
	);
	const result = await execute(root, command, testCaseOf({workflow: {maxTotalCalls: 1, requiredFirstTool: 'grep', maxOutputBytes: 1_000}}));

	assert.equal(result.grade.success, true);
	assert.equal(result.workflow.result, 'fail');
	assert.equal(result.valid, true);
	assert.equal(result.outcome, 'completed');
});
