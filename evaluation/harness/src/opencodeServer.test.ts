import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {isolatedProcessEnvironmentOf} from './processEnvironment.ts';
import {OpenCodeServerError, openReadyServerOf, startOpenCodeServer} from './opencodeServer.ts';

const serverScriptOf = (statuses: readonly string[]): string =>
	[
		'#!/usr/bin/env node',
		"import {createServer} from 'node:http';",
		`const statuses = ${JSON.stringify(statuses)};`,
		'let index = 0;',
		'const server = createServer((request, response) => {',
		"\tif (request.url === '/api/mcp') {",
		'\t\tconst status = statuses[Math.min(index, statuses.length - 1)];',
		'\t\tindex += 1;',
		"\t\tresponse.writeHead(200, {'content-type': 'application/json'});",
		"\t\tresponse.end(JSON.stringify({data: [{name: 'codeindex', status: {status}}]}));",
		'\t\treturn;',
		'\t}',
		'\tresponse.writeHead(404);',
		'\tresponse.end();',
		'});',
		"await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
		'const address = server.address();',
		String.raw`process.stdout.write('server listening on http://127.0.0.1:' + address.port + '\n');`,
		String.raw`process.stdout.write('server password test-password\n');`,
		'await new Promise(() => {});',
		'',
	].join('\n');

const silentScriptOf = (): string => ['#!/usr/bin/env node', 'process.stdin.resume();', 'setInterval(() => {}, 1000);', ''].join('\n');

const exitingScriptOf = (): string => ['#!/usr/bin/env node', 'process.exit(1);', ''].join('\n');

const rootOf = (testContext: TestContext, prefix: string): string => {
	const root = mkdtempSync(path.join(tmpdir(), prefix));

	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const commandOf = (root: string, name: string, script: string): string => {
	const file = path.join(root, name);

	writeFileSync(file, script, 'utf8');
	chmodSync(file, 0o755);

	return file;
};

describe('opencodeServer', () => {
	it('waits through pending registration until the configured server is connected', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-server-pending-');
		const command = commandOf(root, 'opencode', serverScriptOf(['pending', 'pending', 'connected']));
		const server = await startOpenCodeServer({cwd: root, env: isolatedProcessEnvironmentOf(), command});

		try {
			const readiness = await server.awaitMcpReady(['codeindex'], 5000);

			assert.equal(readiness.ready, true);
			assert.ok(readiness.attempts >= 3);
			assert.deepEqual(
				readiness.servers.map((item) => item.status),
				['connected'],
			);
		} finally {
			await server.close();
		}
	});

	it('allows a reconnect after a failed status', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-server-reconnect-');
		const command = commandOf(root, 'opencode', serverScriptOf(['failed', 'connected']));
		const server = await startOpenCodeServer({cwd: root, env: isolatedProcessEnvironmentOf(), command});

		try {
			const readiness = await server.awaitMcpReady(['codeindex'], 5000);

			assert.equal(readiness.ready, true);
		} finally {
			await server.close();
		}
	});

	it('records a closed cause when a failed server never reconnects', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-server-failed-');
		const command = commandOf(root, 'opencode', serverScriptOf(['failed']));
		const server = await startOpenCodeServer({cwd: root, env: isolatedProcessEnvironmentOf(), command});

		try {
			const readiness = await server.awaitMcpReady(['codeindex'], 500);

			assert.equal(readiness.ready, false);
			assert.equal(readiness.cause, 'mcp-connect-failed');
		} finally {
			await server.close();
		}
	});

	it('records a closed cause when registration never completes', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-server-timeout-');
		const command = commandOf(root, 'opencode', serverScriptOf(['pending']));
		const server = await startOpenCodeServer({cwd: root, env: isolatedProcessEnvironmentOf(), command});

		try {
			const readiness = await server.awaitMcpReady(['codeindex'], 300);

			assert.equal(readiness.ready, false);
			assert.equal(readiness.cause, 'mcp-readiness-timeout');
		} finally {
			await server.close();
		}
	});

	it('refuses to admit a prompt when an expected server is missing', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-server-missing-');
		const command = commandOf(root, 'opencode', serverScriptOf(['pending']));

		await assert.rejects(
			openReadyServerOf({cwd: root, env: isolatedProcessEnvironmentOf(), command, expectedServers: ['codeindex'], readinessTimeoutMs: 300}),
			(error: unknown) => error instanceof OpenCodeServerError && error.cause === 'mcp-readiness-timeout',
		);
	});

	it('fails before an endpoint exists and before a prompt can be admitted', async (testContext: TestContext) => {
		const root = rootOf(testContext, 'codeindex-server-start-');
		const silent = commandOf(root, 'silent', silentScriptOf());
		const exiting = commandOf(root, 'exiting', exitingScriptOf());

		await assert.rejects(
			startOpenCodeServer({cwd: root, env: isolatedProcessEnvironmentOf(), command: silent, startTimeoutMs: 200}),
			(error: unknown) => error instanceof OpenCodeServerError && error.cause === 'server-start-timeout',
		);
		await assert.rejects(startOpenCodeServer({cwd: root, env: isolatedProcessEnvironmentOf(), command: exiting}), {
			name: 'OpenCodeServerError',
			message: /server-exited/u,
		});
	});
});
