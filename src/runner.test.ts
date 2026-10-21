import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {clientStoreOf, type ClientStoreType} from './isolation.ts';
import {runOnce, writeResult} from './runner.ts';
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

const clientStore = (root: string): ClientStoreType =>
	clientStoreOf({
		campaignStore: null,
		campaignDir: path.join(root, 'campaign'),
		environment: {XDG_DATA_HOME: path.join(root, 'data')},
		homeDirectory: path.join(root, 'home'),
	});

const execute = (
	root: string,
	command: string,
	testCase: CaseType,
	store: ClientStoreType = clientStore(root),
) =>
	runOnce({
		cwd: root,
		testCase,
		treatment,
		surface: toolSurfaceOf(treatment),
		repetition: 1,
		model: 'provider/model',
		revision: 'abc1234',
		identityHash: 'a'.repeat(64),
		clientStore: store,
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
	assert.equal(result.isolationMode, 'detached-worktree');
	assert.equal(result.clientStore, 'ephemeral');
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
			`printf '%s\\n' "$OPENCODE_DB" > ${quote(path.join(witness, 'db.txt'))}`,
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
		assert.equal(readFileSync(path.join(witness, 'db.txt'), 'utf8').trim(), ':memory:');
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

	assert.equal(result.clientStore, 'campaign-local');
	assert.equal(readFileSync(path.join(witness, 'db.txt'), 'utf8').trim(), store.path);
	assert.notEqual(store.path, path.join(root, 'data', 'opencode', 'opencode.db'));
});

test('a failed execution is persisted as an inspectable failed result', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const command = scriptOf(
		root,
		'failed',
		[
			"cat <<'EVENTS'",
			String.raw`{"type":"error","error":{"type":"provider.no-route","message":"boom"}}`,
			'EVENTS',
			'exit 3',
		].join('\n'),
	);

	const result = await execute(root, command, testCaseOf());
	const file = path.join(root, 'results', 'rep-1.json');

	writeResult(file, result);

	const stored = JSON.parse(readFileSync(file, 'utf8')) as {outcome: string; exitCode: number | null; valid: boolean};

	assert.equal(result.outcome, 'failed');
	assert.equal(result.valid, false);
	assert.equal(result.exitCode, 3);
	assert.equal(result.invalidReason, 'agent exited with 3');
	assert.deepEqual(stored, {...result, outcome: 'failed', exitCode: 3, valid: false});
});

test('a hard timeout terminates the whole process group and stays inspectable', async (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const grandchild = path.join(root, 'grandchild.txt');
	const command = scriptOf(
		root,
		'timed-out',
		[
			`node -e 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "alive"), 600)' ${quote(grandchild)} &`,
			'sleep 30',
		].join('\n'),
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
