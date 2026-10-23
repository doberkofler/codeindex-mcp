import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {SurfaceReadinessError, type SurfaceRequestType} from './requestSurface.ts';
import {presentedToolsOf} from './surface.ts';
import {capturePresentedTools, requestToolNamesOf} from './surfaceProbe.ts';
import {toolSurfaceOf, treatmentOf} from './treatment.ts';

const ORDINARY = ['bash', 'edit', 'glob', 'grep', 'list', 'read'];

const accepted = treatmentOf({
	id: 'accepted',
	kind: 'codeindex',
	ordinaryTools: ORDINARY,
	codeMode: 'absent',
	artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
	mcp: {server: 'codeindex', codemode: false},
});

const noIndex = treatmentOf({
	id: 'no-index',
	kind: 'no-index',
	ordinaryTools: ORDINARY,
	codeMode: 'absent',
	artifact: null,
	mcp: null,
});

const indexedSurface = toolSurfaceOf(accepted, ['find_symbol', 'read_symbol']);
const plainSurface = toolSurfaceOf(noIndex);

const rootOf = (testContext: TestContext, prefix: string): Readonly<{root: string; workspace: string; command: string}> => {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});
	const workspace = path.join(root, 'workspace');
	const bin = path.join(root, 'bin');
	mkdirSync(workspace, {recursive: true});
	mkdirSync(bin, {recursive: true});

	return {root, workspace, command: path.join(bin, 'opencode')};
};

const probeScriptOf = (requests: readonly Readonly<{tools?: readonly string[]; title?: boolean}>[]): string =>
	[
		'#!/usr/bin/env node',
		"const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');",
		"const base = config.providers?.['surface-probe']?.settings?.baseURL;",
		'const post = async (request) => {',
		// oxlint-disable-next-line eslint/no-template-curly-in-string -- The text is generated fixture source; the placeholder interpolates only when that script runs.
		"	await fetch(`${base}/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(request)});",
		'};',
		...requests.flatMap((request) =>
			request.title === true
				? ["await post({messages: [{role: 'user', content: 'Generate a short title for this conversation'}]});"]
				: [
						`await post({messages: [{role: 'user', content: 'Reply with the JSON object {"files":[],"absent":true} and nothing else.'}], tools: ${JSON.stringify(
							(request.tools ?? []).map((name) => ({type: 'function', function: {name}})),
						)}});`,
					],
		),
		'',
	].join('\n');

const installCommandOf = (command: string, script: string): void => {
	writeFileSync(command, script, {encoding: 'utf8', mode: 0o755});
};

const hasIndexToolOf = (requests: readonly SurfaceRequestType[]): boolean =>
	requests.some((request) => request.toolNames.some((name) => name.startsWith('codeindex_')));

const gatedScriptOf = (tools: readonly string[]): string =>
	[
		'#!/usr/bin/env node',
		"import {existsSync, writeFileSync} from 'node:fs';",
		"import {createServer} from 'node:http';",
		'const [mode] = process.argv.slice(2);',
		"if (mode === 'serve') {",
		'\tconst connectedAt = Date.now() + 300;',
		'\tlet marked = false;',
		'\tconst server = createServer((request, response) => {',
		"\t\tif (request.method === 'POST' && request.url === '/api/experimental/mcp/codeindex/disconnect') {",
		'\t\t\tresponse.writeHead(204);',
		'\t\t\tresponse.end();',
		'\t\t\treturn;',
		'\t\t}',
		"\t\tif (request.url !== '/api/mcp') { response.writeHead(404); response.end(); return; }",
		'\t\tconst connected = Date.now() >= connectedAt;',
		"\t\tif (connected && !marked) { marked = true; writeFileSync(process.env.FAKE_READY_MARKER, '1'); }",
		"\t\tresponse.writeHead(200, {'content-type': 'application/json'});",
		"\t\tresponse.end(JSON.stringify({data: [{name: 'codeindex', status: {status: connected ? 'connected' : 'pending'}}]}));",
		'\t});',
		"\tserver.listen(0, '127.0.0.1', () => {",
		'\t\tconst address = server.address();',
		String.raw`		process.stdout.write('server listening on http://127.0.0.1:' + address.port + '\n');`,
		String.raw`		process.stdout.write('server password gate-proof\n');`,
		'\t});',
		'} else {',
		'\tif (!existsSync(process.env.FAKE_READY_MARKER)) process.exit(9);',
		"\tconst config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');",
		"\tconst base = config.providers?.['surface-probe']?.settings?.baseURL;",
		'\tconst post = async (body) => {',
		// oxlint-disable-next-line eslint/no-template-curly-in-string -- The text is generated fixture source; the placeholder interpolates only when that script runs.
		"\t\tawait fetch(`${base}/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});",
		'\t};',
		"\tawait post({messages: [{role: 'user', content: 'Generate a short title for this conversation'}]});",
		`\tawait post({messages: [{role: 'user', content: 'Reply with the JSON object {"files":[],"absent":true} and nothing else.'}], tools: ${JSON.stringify(
			tools.map((name) => ({type: 'function', function: {name}})),
		)}});`,
		'}',
		'',
	].join('\n');

describe('surfaceProbe', () => {
	it('a request without tools is a title request, not an empty surface', () => {
		assert.deepEqual(requestToolNamesOf({messages: []}), []);
		assert.deepEqual(requestToolNamesOf({tools: [{function: {name: 'read'}}]}), ['read']);
		assert.throws(() => requestToolNamesOf({tools: 'read'}), /must be an array/u);
		assert.throws(() => requestToolNamesOf({tools: [{function: {}}]}), /without a function name/u);
	});

	it('captures the exact indexed surface from agent request 1 and separates the title request', async (testContext: TestContext) => {
		const {workspace, command} = rootOf(testContext, 'codeindex-surface-probe-');
		const exact = presentedToolsOf(indexedSurface);

		installCommandOf(command, probeScriptOf([{title: true}, {tools: exact}]));

		const captured = await capturePresentedTools({workspace, surface: indexedSurface, command, timeoutMs: 30_000});

		assert.deepEqual(captured.tools, exact);
		assert.equal(captured.titleRequests, 1);
		assert.equal(captured.agentRequests, 1);
		assert.deepEqual(
			captured.requests.map((request) => request.kind),
			['title', 'agent'],
		);
		assert.equal(captured.ledger.firstAgentRequest?.ordinal, 2);
		assert.equal(captured.ledger.result, 'pass');
	});

	it('rejects a first agent request that is missing a CodeIndex tool even when later requests add it', async (testContext: TestContext) => {
		const {workspace, command} = rootOf(testContext, 'codeindex-surface-late-');
		const exact = presentedToolsOf(indexedSurface);
		const withoutIndex = exact.filter((name) => !name.startsWith('codeindex_'));

		installCommandOf(command, probeScriptOf([{tools: withoutIndex}, {tools: exact}]));

		const rejection = await capturePresentedTools({workspace, surface: indexedSurface, command, timeoutMs: 30_000}).catch((error: unknown) => error);

		assert.ok(rejection instanceof SurfaceReadinessError);
		assert.equal(rejection.cause, 'incomplete-surface');
		assert.equal(rejection.ledger.firstAgentRequest?.ordinal, 1);
		assert.match(rejection.message, /codeindex_find_symbol is not presented/u);
	});

	it('rejects a no-index request that exposes a CodeIndex tool', async (testContext: TestContext) => {
		const {workspace, command} = rootOf(testContext, 'codeindex-surface-no-index-');
		const exact = presentedToolsOf(plainSurface);

		installCommandOf(command, probeScriptOf([{tools: [...exact, 'codeindex_find_symbol']}]));

		const rejection = await capturePresentedTools({workspace, surface: plainSurface, command, timeoutMs: 30_000}).catch((error: unknown) => error);

		assert.ok(rejection instanceof SurfaceReadinessError);
		assert.equal(rejection.cause, 'codeindex-in-no-index');
	});

	it('a probe that never admits an agent request fails instead of accepting an empty surface', async (testContext: TestContext) => {
		const {workspace, command} = rootOf(testContext, 'codeindex-surface-empty-');

		writeFileSync(command, `${probeScriptOf([{title: true}])}\nawait new Promise(() => {});\n`, {encoding: 'utf8', mode: 0o755});

		await assert.rejects(capturePresentedTools({workspace, surface: indexedSurface, command, timeoutMs: 5000}), /admitted no agent request|timed out/u);
	});

	it('admits the prompt only after the configured MCP server is connected', async (testContext: TestContext) => {
		const {root, workspace, command} = rootOf(testContext, 'codeindex-surface-gated-');
		const marker = path.join(root, 'mcp-ready');
		const previous = process.env['FAKE_READY_MARKER'];

		installCommandOf(command, gatedScriptOf(presentedToolsOf(indexedSurface)));
		process.env['FAKE_READY_MARKER'] = marker;

		try {
			const captured = await capturePresentedTools({
				workspace,
				surface: indexedSurface,
				serverCommand: command,
				mcpServer: 'codeindex',
				timeoutMs: 30_000,
			});

			const readiness = captured.serverReadiness;

			assert.deepEqual(captured.tools, presentedToolsOf(indexedSurface));
			assert.ok(readiness !== null);
			assert.equal(readiness.ready, true);
			assert.ok(readiness.attempts >= 2);
		} finally {
			if (previous === undefined) {
				delete process.env['FAKE_READY_MARKER'];
			} else {
				process.env['FAKE_READY_MARKER'] = previous;
			}
		}
	});

	it('twenty consecutive cold starts per treatment expose the exact surface on request 1', async (testContext: TestContext) => {
		const indexedRoot = rootOf(testContext, 'codeindex-surface-cold-indexed-');
		const plainRoot = rootOf(testContext, 'codeindex-surface-cold-plain-');

		installCommandOf(indexedRoot.command, probeScriptOf([{title: true}, {tools: presentedToolsOf(indexedSurface)}]));
		installCommandOf(plainRoot.command, probeScriptOf([{title: true}, {tools: presentedToolsOf(plainSurface)}]));

		for (let coldStart = 1; coldStart <= 20; coldStart += 1) {
			const indexed = await capturePresentedTools({workspace: indexedRoot.workspace, surface: indexedSurface, command: indexedRoot.command, timeoutMs: 30_000});

			assert.deepEqual(indexed.tools, presentedToolsOf(indexedSurface));

			const plain = await capturePresentedTools({workspace: plainRoot.workspace, surface: plainSurface, command: plainRoot.command, timeoutMs: 30_000});

			assert.deepEqual(plain.tools, presentedToolsOf(plainSurface));
			assert.equal(hasIndexToolOf(plain.ledger.requests), false);
		}
	}, 180_000);
});
