import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {assertMcpReady, probeMcpReadiness} from './mcpReadiness.ts';

const serverScriptOf = (
	tools: readonly string[],
	options: Readonly<{delayMs?: number; initializeError?: boolean; exitImmediately?: boolean; reconnectMarker?: string}> = {},
): string => {
	const respond = options.delayMs === undefined ? 'respond(message);' : `setTimeout(() => respond(message), ${options.delayMs});`;

	return [
		"import {existsSync, writeFileSync} from 'node:fs';",
		"import {createInterface} from 'node:readline';",
		...(options.reconnectMarker === undefined
			? []
			: [`const marker = ${JSON.stringify(options.reconnectMarker)};`, "if (!existsSync(marker)) { writeFileSync(marker, 'first'); process.exit(1); }"]),
		...(options.exitImmediately === true ? ['process.exit(1);'] : []),
		'const lines = createInterface({input: process.stdin});',
		String.raw`const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");`,
		'const respond = (message) => {',
		"\tif (message.method === 'initialize') {",
		...(options.initializeError === true
			? ["\t\tsend({jsonrpc: '2.0', id: message.id, error: {code: -32603, message: 'not ready'}});"]
			: [
					"\t\tsend({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fake', version: '1'}}});",
				]),
		'\t}',
		"\tif (message.method === 'tools/list') {",
		`\t\tsend({jsonrpc: '2.0', id: message.id, result: {tools: ${JSON.stringify(tools.map((name) => ({name})))}}});`,
		'\t}',
		'};',
		"lines.on('line', (line) => {",
		'\tconst message = JSON.parse(line);',
		`\t${respond}`,
		'});',
		'',
	].join('\n');
};

const rootOf = (testContext: TestContext, prefix: string): string => {
	const root = mkdtempSync(path.join(tmpdir(), prefix));

	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const serverOf = (root: string, name: string, script: string): string => {
	const file = path.join(root, name);

	writeFileSync(file, script, 'utf8');

	return file;
};

describe('mcpReadiness', () => {
	it('requires a real handshake and the declared native catalog', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-ready-');
		const server = serverOf(root, 'server.mjs', serverScriptOf(['find_symbol', 'read_symbol']));

		const record = await probeMcpReadiness({command: [process.execPath, server], cwd: root, expectedTools: ['find_symbol', 'read_symbol']});

		assert.equal(record.ready, true);
		assert.equal(record.cause, null);
		assert.equal(record.serverName, 'fake');
		assert.deepEqual(record.tools, ['find_symbol', 'read_symbol']);
		assert.equal(record.attempts, 1);
		assert.equal(assertMcpReady(record), record);
	});

	it('waits for delayed registration within the bound instead of observing only the process', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-ready-delayed-');
		const server = serverOf(root, 'server.mjs', serverScriptOf(['read'], {delayMs: 200}));

		const record = await probeMcpReadiness({command: [process.execPath, server], cwd: root, expectedTools: ['read'], timeoutMs: 5000});

		assert.equal(record.ready, true);
		assert.deepEqual(record.tools, ['read']);
	});

	it('reconnects through a fresh process after a transient startup failure', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-ready-reconnect-');
		const marker = path.join(root, 'first-launch');
		const server = serverOf(root, 'server.mjs', serverScriptOf(['read'], {reconnectMarker: marker}));

		const record = await probeMcpReadiness({command: [process.execPath, server], cwd: root, expectedTools: ['read'], attempts: 2});

		assert.equal(record.ready, true);
		assert.equal(record.attempts, 2);
		assert.deepEqual(
			record.failures.map((failure) => failure.cause),
			['server-exited'],
		);
	});

	it('fails with a closed cause when the server never starts', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-ready-failed-');
		const server = serverOf(root, 'server.mjs', serverScriptOf(['read'], {exitImmediately: true}));

		const record = await probeMcpReadiness({command: [process.execPath, server], cwd: root, attempts: 2});

		assert.equal(record.ready, false);
		assert.equal(record.cause, 'server-exited');
		assert.throws(() => assertMcpReady(record), {name: 'McpReadinessError', message: /server-exited/u});
	});

	it('fails with a closed cause when initialize never completes', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-ready-timeout-');
		const server = serverOf(root, 'server.mjs', ['process.stdin.resume();', 'await new Promise(() => {});', ''].join('\n'));

		const record = await probeMcpReadiness({command: [process.execPath, server], cwd: root, attempts: 1, timeoutMs: 200});

		assert.equal(record.ready, false);
		assert.equal(record.cause, 'initialize-timeout');
	});

	it('fails with a closed cause for an initialize error and for an invalid catalog', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-ready-invalid-');
		const errored = serverOf(root, 'errored.mjs', serverScriptOf(['read'], {initializeError: true}));
		const empty = serverOf(root, 'empty.mjs', serverScriptOf([]));
		const duplicate = serverOf(root, 'duplicate.mjs', serverScriptOf(['read', 'read']));
		const mismatch = serverOf(root, 'mismatch.mjs', serverScriptOf(['read']));

		const initializeError = await probeMcpReadiness({command: [process.execPath, errored], cwd: root, attempts: 1});
		const emptyCatalog = await probeMcpReadiness({command: [process.execPath, empty], cwd: root, attempts: 1});
		const duplicateCatalog = await probeMcpReadiness({command: [process.execPath, duplicate], cwd: root, attempts: 1});
		const mismatchCatalog = await probeMcpReadiness({command: [process.execPath, mismatch], cwd: root, expectedTools: ['read', 'write'], attempts: 1});

		assert.equal(initializeError.cause, 'initialize-error');
		assert.equal(emptyCatalog.cause, 'empty-catalog');
		assert.equal(duplicateCatalog.cause, 'duplicate-tools');
		assert.equal(mismatchCatalog.cause, 'catalog-mismatch');
	});

	it('fails with a spawn cause for an empty command', async () => {
		const record = await probeMcpReadiness({command: [], cwd: tmpdir(), attempts: 1});

		assert.equal(record.ready, false);
		assert.equal(record.cause, 'spawn-error');
	});

	it('does not report readiness for a process that only starts and exits', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-ready-registration-');
		const server = serverOf(root, 'server.mjs', ['process.stdin.resume();', 'process.exit(0);', ''].join('\n'));

		const record = await probeMcpReadiness({command: [process.execPath, server], cwd: root, attempts: 1});

		assert.equal(record.ready, false);
		assert.equal(record.cause, 'server-exited');
	});
});
