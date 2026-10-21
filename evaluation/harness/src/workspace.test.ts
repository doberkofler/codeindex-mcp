import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {hashOf} from './hash.ts';
import {treatmentOf, type TreatmentDefinitionType} from './treatment.ts';
import {
	assertCheckout,
	checkoutVerificationOf,
	contentManifestHashOf,
	ensureWorkspaces,
	removeWorkspaces,
	restoreWorkspace,
	subjectIdentityOf,
	workspaceContextOf,
	type WorkspaceContextType,
} from './workspace.ts';

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-workspace-'));
	testContext.after(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const gitIn = (repo: string, args: readonly string[]): string =>
	execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

const commitOf = (repo: string, message: string): string => {
	gitIn(repo, ['add', '.']);
	gitIn(repo, ['-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@example.com', 'commit', '--quiet', '-m', message]);

	return gitIn(repo, ['rev-parse', 'HEAD']).trim();
};

const repositoryOf = (root: string): string => {
	mkdirSync(root, {recursive: true});
	gitIn(root, ['init', '--quiet', '--initial-branch=main']);
	writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
	writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

	return commitOf(root, 'initial');
};

const treatment: TreatmentDefinitionType = treatmentOf({
	id: 'no-index',
	kind: 'no-index',
	ordinaryTools: ['bash', 'glob', 'grep', 'list', 'read'],
	codeMode: 'absent',
	artifact: null,
	mcp: null,
});

const contextOf = (harnessRoot: string, subjectRepo: string, revision: string): WorkspaceContextType =>
	workspaceContextOf(harnessRoot, {subjectRepo, subject: subjectIdentityOf(subjectRepo, revision)});

test('a subject checkout is pinned to a clean, exact revision', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const repo = path.join(root, 'subject');
	const revision = repositoryOf(repo);
	const subject = subjectIdentityOf(repo, revision.slice(0, 7));

	assert.equal(subject.mode, 'detached-worktree');
	assert.equal(subject.revision, revision);
	assert.equal(subject.declaredRevision, revision.slice(0, 7));
	assert.equal(
		subject.contentManifestHash,
		hashOf([
			{path: 'a.ts', digest: gitIn(repo, ['rev-parse', 'HEAD:a.ts']).trim()},
			{path: 'pnpm-lock.yaml', digest: gitIn(repo, ['rev-parse', 'HEAD:pnpm-lock.yaml']).trim()},
		]),
	);
	assert.notEqual(subject.lockFileHash, null);

	writeFileSync(path.join(repo, 'untracked.ts'), 'export const b = 2;\n', 'utf8');
	assert.throws(() => subjectIdentityOf(repo, revision), /uncommitted change/);
	rmSync(path.join(repo, 'untracked.ts'));

	writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n', 'utf8');
	commitOf(repo, 'second');
	assert.throws(() => subjectIdentityOf(repo, revision), /subject repository is at .* expected/);
});

test('a workspace is created, verified, restored, and rejects every authored change', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const subjectRepo = path.join(root, 'subject');
	const revision = repositoryOf(subjectRepo);
	const context = contextOf(path.join(root, 'harness'), subjectRepo, revision);

	ensureWorkspaces(context, [treatment]);

	const workspace = context.workspacePath('no-index');
	assert.equal(existsSync(path.join(workspace, 'a.ts')), true);
	assert.equal(checkoutVerificationOf(context, treatment).reason, null);
	assertCheckout(context, treatment);

	writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 99;\n', 'utf8');
	writeFileSync(path.join(workspace, 'scratch.md'), 'scratch\n', 'utf8');
	const dirty = checkoutVerificationOf(context, treatment);

	assert.equal(dirty.checkoutClean, false);
	assert.equal(dirty.revisionMatch, true);
	assert.match(dirty.reason ?? '', /authored change/);
	assert.throws(() => assertCheckout(context, treatment), /not a clean checkout/);

	const restoration = restoreWorkspace(context, treatment);

	assert.equal(restoration.restored, true);
	assert.equal(readFileSync(path.join(workspace, 'a.ts'), 'utf8'), 'export const a = 1;\n');
	assert.equal(existsSync(path.join(workspace, 'scratch.md')), false);
	assertCheckout(context, treatment);

	// An edit from one execution never survives into the next one.
	assert.equal(readFileSync(path.join(workspace, 'a.ts'), 'utf8'), 'export const a = 1;\n');

	removeWorkspaces(context, [treatment]);
	assert.equal(existsSync(workspace), false);
});

test('a workspace at a different revision is rejected before execution', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const subjectRepo = path.join(root, 'subject');
	const revision = repositoryOf(subjectRepo);
	const context = contextOf(path.join(root, 'harness'), subjectRepo, revision);

	ensureWorkspaces(context, [treatment]);

	const workspace = context.workspacePath('no-index');
	writeFileSync(path.join(subjectRepo, 'a.ts'), 'export const a = 3;\n', 'utf8');
	const second = commitOf(subjectRepo, 'second');
	gitIn(workspace, ['checkout', '--quiet', '--detach', second]);

	const verification = checkoutVerificationOf(context, treatment);

	assert.equal(verification.revisionMatch, false);
	assert.equal(verification.checkoutClean, true);
	assert.match(verification.reason ?? '', /workspace is at .* expected/);
	assert.throws(() => assertCheckout(context, treatment), /not a clean checkout/);

	assert.equal(restoreWorkspace(context, treatment).restored, true);
	assertCheckout(context, treatment);
});

test('a restoration failure is reported instead of thrown', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const subjectRepo = path.join(root, 'subject');
	const revision = repositoryOf(subjectRepo);
	const context = contextOf(path.join(root, 'harness'), subjectRepo, revision);

	ensureWorkspaces(context, [treatment]);

	const workspace = context.workspacePath('no-index');
	writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 42;\n', 'utf8');
	rmSync(path.join(workspace, '.git'));

	const restoration = restoreWorkspace(context, treatment);

	assert.equal(restoration.restored, false);
	assert.notEqual(restoration.reason, null);
	assert.equal(restoration.verification.checkoutClean, false);
});

test('without version control a disposable copy is pinned by its content manifest', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const subjectRepo = path.join(root, 'subject');
	const harnessRoot = path.join(root, 'harness');

	mkdirSync(path.join(subjectRepo, 'src'), {recursive: true});
	mkdirSync(path.join(subjectRepo, 'node_modules'), {recursive: true});
	writeFileSync(path.join(subjectRepo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
	writeFileSync(path.join(subjectRepo, 'package.json'), '{"name":"fixture"}\n', 'utf8');

	const subject = subjectIdentityOf(subjectRepo, 'declared-revision');

	assert.equal(subject.mode, 'disposable-copy');
	assert.equal(subject.revision, null);
	assert.equal(subject.declaredRevision, 'declared-revision');
	assert.equal(subject.lockFileHash, null);
	assert.equal(subject.contentManifestHash, contentManifestHashOf(subjectRepo));

	const context = workspaceContextOf(harnessRoot, {subjectRepo, subject});
	ensureWorkspaces(context, [treatment]);

	const workspace = context.workspacePath('no-index');
	assert.equal(existsSync(path.join(workspace, 'src', 'a.ts')), true);
	assert.equal(checkoutVerificationOf(context, treatment).reason, null);

	writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
	const dirty = checkoutVerificationOf(context, treatment);

	assert.equal(dirty.revisionMatch, false);
	assert.equal(dirty.checkoutClean, false);
	assert.match(dirty.reason ?? '', /content manifest/);

	const restoration = restoreWorkspace(context, treatment);

	assert.equal(restoration.restored, true);
	assert.equal(readFileSync(path.join(workspace, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
	assert.equal(existsSync(path.join(workspace, 'node_modules')), true);

	removeWorkspaces(context, [treatment]);
	assert.equal(existsSync(workspace), false);
});
