import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {terminateActiveAttempts, withRestoration} from './runner.ts';
import {clientStore, execute, quote, scriptOf, temporaryRoot, testCaseOf} from './runnerTestSupport.ts';

describe('runnerRecovery', () => {
	it('a successful restoration keeps the execution outcome', async (testContext: TestContext) => {
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

	it('a retry starts from a restored workspace, never from the previous attempt edits', async (testContext: TestContext) => {
		const root = temporaryRoot(testContext);
		const witness = path.join(root, 'witness');
		mkdirSync(witness, {recursive: true});
		const command = scriptOf(
			root,
			'retry',
			[
				`count=$(cat ${quote(path.join(witness, 'count'))} 2>/dev/null || printf 0)`,
				`count=$((count + 1))`,
				`printf '%s' "$count" > ${quote(path.join(witness, 'count'))}`,
				`if [ -e ${quote(path.join(root, 'dirty.txt'))} ]; then exit 9; fi`,
				`if [ "$count" -eq 1 ]; then printf 'edited\\n' > ${quote(path.join(root, 'dirty.txt'))}; exit 3; fi`,
				"cat <<'EVENTS'",
				String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
				String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
				'EVENTS',
			].join('\n'),
		);
		const result = await execute(root, command, testCaseOf(), {
			store: clientStore(root),
			retry: {maxAttempts: 2, backoffMs: () => 0},
			prepareRetry: () => {
				rmSync(path.join(root, 'dirty.txt'), {force: true});

				return {restored: true, reason: null};
			},
		});

		assert.equal(readFileSync(path.join(witness, 'count'), 'utf8'), '2');
		assert.equal(result.valid, true);
		assert.equal(result.outcome, 'completed');
		assert.equal(result.attempts.length, 2);
		assert.equal(existsSync(path.join(root, 'dirty.txt')), false);
	});

	it('a failed restoration aborts the slot instead of retrying from edits', async (testContext: TestContext) => {
		const root = temporaryRoot(testContext);
		const witness = path.join(root, 'witness');
		mkdirSync(witness, {recursive: true});
		const command = scriptOf(
			root,
			'retry-abort',
			[
				`count=$(cat ${quote(path.join(witness, 'count'))} 2>/dev/null || printf 0)`,
				`count=$((count + 1))`,
				`printf '%s' "$count" > ${quote(path.join(witness, 'count'))}`,
				'exit 3',
			].join('\n'),
		);
		const result = await execute(root, command, testCaseOf(), {
			store: clientStore(root),
			retry: {maxAttempts: 3, backoffMs: () => 0},
			prepareRetry: () => ({restored: false, reason: 'workspace .git is missing'}),
		});

		assert.equal(readFileSync(path.join(witness, 'count'), 'utf8'), '1');
		assert.equal(result.attempts.length, 1);
		assert.equal(result.valid, false);
		assert.equal(result.outcome, 'failed');
		assert.equal(result.defects.includes('dirty-isolation'), true);
		assert.match(result.invalidReason ?? '', /restoration before retry failed: workspace \.git is missing/u);
	});

	it('a termination signal reaches the detached execution group', async (testContext: TestContext) => {
		const root = temporaryRoot(testContext);
		const command = scriptOf(root, 'terminate', ['sleep 30', ''].join('\n'));
		const started = Date.now();
		const pending = execute(root, command, testCaseOf({timeoutMs: 60_000}));

		setTimeout(() => {
			terminateActiveAttempts('SIGTERM');
		}, 250);
		const result = await pending;

		assert.ok(Date.now() - started < 15_000);
		assert.equal(result.outcome, 'failed');
		assert.equal(result.exitCode, null);
		assert.equal(result.timedOut, false);
	});

	it('a declared post-run check is reported separately from correctness and process success', async (testContext: TestContext) => {
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
		assert.equal(failing.postRun.exitCode, 4);
		assert.equal(failing.grade.success, true);
		assert.equal(failing.valid, true);
		assert.equal(failing.outcome, 'completed');
	});

	it('a workflow violation does not change answer correctness or process validity', async (testContext: TestContext) => {
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
		const result = await execute(root, command, testCaseOf({workflow: {maxTotalCalls: 1, requiredFirstTool: 'grep', maxOutputBytes: 1000}}));

		assert.equal(result.grade.success, true);
		assert.equal(result.workflow.result, 'fail');
		assert.equal(result.valid, true);
		assert.equal(result.outcome, 'completed');
	});
});
