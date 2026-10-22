import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {postRunOf, skippedPostRunOf} from './postRun.ts';
import {type PostRunCheckType} from './schema.ts';

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-post-run-'));
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const checkOf = (overrides: Partial<PostRunCheckType> = {}): PostRunCheckType => ({
	command: process.execPath,
	args: ['-e', 'process.exit(0)'],
	expectedExitCode: 0,
	timeoutMs: 10_000,
	...overrides,
});

describe('postRun', () => {
	it('a matching post-run exit code passes and keeps its assertions', async (testContext: TestContext) => {
		const result = await postRunOf(checkOf(), temporaryRoot(testContext));

		assert.equal(result.result, 'pass');
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, false);
		assert.equal(result.error, null);
		assert.equal(result.assertions.find((item) => item.id === 'post-run.exit-code')?.result, 'pass');
	});

	it('a non-matching exit code fails without touching correctness', async (testContext: TestContext) => {
		const result = await postRunOf(checkOf({args: ['-e', 'process.exit(3)']}), temporaryRoot(testContext));
		const expected = await postRunOf(checkOf({args: ['-e', 'process.exit(3)'], expectedExitCode: 3}), temporaryRoot(testContext));

		assert.equal(result.result, 'fail');
		assert.equal(result.exitCode, 3);
		assert.equal(result.assertions.find((item) => item.id === 'post-run.exit-code')?.result, 'fail');
		assert.equal(expected.result, 'pass');
	});

	it('a post-run timeout is terminal and inspectable', async (testContext: TestContext) => {
		const result = await postRunOf(checkOf({args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 100}), temporaryRoot(testContext));

		assert.equal(result.result, 'fail');
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, null);
		assert.equal(result.assertions.find((item) => item.id === 'post-run.completed')?.result, 'fail');
	});

	it('a missing command fails with the spawn error', async (testContext: TestContext) => {
		const result = await postRunOf(checkOf({command: 'codeindex-evaluation-command-that-does-not-exist'}), temporaryRoot(testContext));

		assert.equal(result.result, 'fail');
		assert.equal(result.exitCode, null);
		assert.notEqual(result.error, null);
		assert.match(result.reason, /ENOENT|spawn/u);
	});

	it('a skipped post-run check is unevaluated, never a pass', () => {
		const result = skippedPostRunOf(checkOf(), 'the agent timed out');

		assert.equal(result.result, 'unevaluated');
		assert.equal(result.exitCode, null);
		assert.equal(result.assertions[0]?.result, 'unevaluated');
	});
});
