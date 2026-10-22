import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {assertOutsideDataDirectory, campaignStoreRecordOf, clientStoreOf, defaultDataDirectoryOf, isolationRecordOf, prepareClientStore} from './isolation.ts';

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-isolation-'));
	testContext.after(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const environmentOf = (root: string): NodeJS.ProcessEnv => ({XDG_DATA_HOME: path.join(root, 'data')});

void test('the default client store is in-memory and never the default database', () => {
	const store = clientStoreOf({campaignStore: null, campaignDir: '/tmp/campaign'});

	assert.deepEqual(store, {mode: 'ephemeral', path: null, opencodeDb: ':memory:'});
	assert.equal(store.opencodeDb === ':memory:', true);
	assert.deepEqual(campaignStoreRecordOf(store), {kind: 'in-memory'});
	assert.deepEqual(isolationRecordOf(store, 'detached-worktree'), {
		mode: 'detached-worktree',
		standalone: true,
		clientStore: 'ephemeral',
	});
});

void test('a campaign store resolves outside the data directory and keeps its file', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const campaignDir = path.join(root, 'results', 'campaign-a');
	const store = clientStoreOf({
		campaignStore: 'client.db',
		campaignDir,
		environment: environmentOf(root),
		homeDirectory: path.join(root, 'home'),
	});

	assert.equal(store.mode, 'campaign-local');
	assert.equal(store.path, path.join(campaignDir, 'client.db'));
	assert.equal(store.opencodeDb, path.join(campaignDir, 'client.db'));
	assert.equal(path.isAbsolute(store.opencodeDb), true);

	prepareClientStore(store);

	assert.equal(existsSync(path.dirname(store.path)), true);
	assert.equal(existsSync(store.path), false);
});

void test('an absolute campaign store is accepted and recorded', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const storePath = path.join(root, 'campaign', 'client.db');
	const store = clientStoreOf({
		campaignStore: storePath,
		campaignDir: path.join(root, 'results'),
		environment: environmentOf(root),
		homeDirectory: path.join(root, 'home'),
	});

	assert.equal(store.path, storePath);
	assert.deepEqual(campaignStoreRecordOf(store), {kind: 'campaign-local-file', path: storePath});
	assert.deepEqual(isolationRecordOf(store, 'detached-worktree'), {
		mode: 'detached-worktree',
		standalone: true,
		clientStore: 'campaign-local',
	});
});

void test('a campaign store inside the OpenCode data directory is rejected', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const dataDirectory = defaultDataDirectoryOf(environmentOf(root), path.join(root, 'home'));
	const campaignDir = path.join(root, 'results');

	assert.equal(dataDirectory, path.join(root, 'data', 'opencode'));
	assert.throws(
		() =>
			clientStoreOf({
				campaignStore: path.join(dataDirectory, 'campaign.db'),
				campaignDir,
				environment: environmentOf(root),
				homeDirectory: path.join(root, 'home'),
			}),
		/outside the OpenCode data directory/u,
	);
	assert.throws(
		() =>
			clientStoreOf({
				campaignStore: dataDirectory,
				campaignDir,
				environment: environmentOf(root),
				homeDirectory: path.join(root, 'home'),
			}),
		/outside the OpenCode data directory/u,
	);
	assert.throws(() => {
		assertOutsideDataDirectory(path.join(dataDirectory, 'opencode.db'), dataDirectory);
	}, /outside/u);
});

void test('an empty campaign store path fails before any process starts', () => {
	assert.throws(() => clientStoreOf({campaignStore: '  ', campaignDir: '/tmp/campaign'}), /requires a path/u);
});

void test('the data directory follows XDG_DATA_HOME and the home fallback', () => {
	assert.equal(defaultDataDirectoryOf({XDG_DATA_HOME: '/xdg/data'}, '/home/operator'), '/xdg/data/opencode');
	assert.equal(defaultDataDirectoryOf({}, '/home/operator'), '/home/operator/.local/share/opencode');
});
