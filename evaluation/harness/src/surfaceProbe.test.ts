import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {capturedSurfaceOf, capturePresentedTools, requestToolNamesOf} from './surfaceProbe.ts';
import {toolSurfaceOf, treatmentOf} from './treatment.ts';

const treatment = treatmentOf({
	id: 'accepted',
	kind: 'codeindex',
	ordinaryTools: ['bash', 'edit', 'glob', 'grep', 'list', 'read'],
	codeMode: 'absent',
	artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
	mcp: {server: 'codeindex', codemode: false},
});

const surface = toolSurfaceOf(treatment, ['find_symbol']);

void test('a request without tools is a title request, not an empty surface', () => {
	assert.deepEqual(requestToolNamesOf({messages: []}), []);
	assert.deepEqual(requestToolNamesOf({tools: [{function: {name: 'read'}}]}), ['read']);
	assert.throws(() => requestToolNamesOf({tools: 'read'}), /must be an array/u);
	assert.throws(() => requestToolNamesOf({tools: [{function: {}}]}), /without a function name/u);
});

void test('captured surfaces union every tool-bearing request', () => {
	const captured = capturedSurfaceOf([
		{messages: []},
		{tools: [{function: {name: 'read'}}, {function: {name: 'edit'}}]},
		{tools: [{function: {name: 'read'}}, {function: {name: 'codeindex_find_symbol'}}]},
	]);

	assert.deepEqual(captured, {
		tools: ['codeindex_find_symbol', 'edit', 'read'],
		agentRequests: 2,
		titleRequests: 1,
	});
});

void test('a private provider probe records the presented tools without a model', async (testContext: TestContext) => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-surface-probe-'));
	testContext.after(() => {
		rmSync(root, {recursive: true, force: true});
	});
	const workspace = path.join(root, 'workspace');
	const bin = path.join(root, 'bin');
	mkdirSync(workspace, {recursive: true});
	mkdirSync(bin, {recursive: true});
	const command = path.join(bin, 'opencode');
	writeFileSync(
		command,
		[
			'#!/usr/bin/env node',
			"const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');",
			"const base = config.providers?.['surface-probe']?.settings?.baseURL;",
			'const post = async (tools) => {',
			// oxlint-disable-next-line eslint/no-template-curly-in-string -- The text is generated fixture source; the placeholder interpolates only when that script runs.
			"	await fetch(`${base}/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({tools})});",
			'};',
			'await post([]);',
			"await post([{function: {name: 'read'}}]);",
			"await post([{function: {name: 'read'}}, {function: {name: 'codeindex_find_symbol'}}]);",
			"await post([{function: {name: 'read'}}, {function: {name: 'codeindex_find_symbol'}}]);",
			'',
		].join('\n'),
		{encoding: 'utf8', mode: 0o755},
	);

	const captured = await capturePresentedTools({workspace, surface, command, timeoutMs: 30_000});

	assert.deepEqual(captured.tools, ['codeindex_find_symbol', 'read']);
	assert.equal(captured.titleRequests, 1);
	assert.ok(captured.agentRequests >= 3);
});

void test('a probe that never receives tools fails instead of accepting an empty surface', async (testContext: TestContext) => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-surface-empty-'));
	testContext.after(() => {
		rmSync(root, {recursive: true, force: true});
	});
	const workspace = path.join(root, 'workspace');
	const bin = path.join(root, 'bin');
	mkdirSync(workspace, {recursive: true});
	mkdirSync(bin, {recursive: true});
	const command = path.join(bin, 'opencode');
	writeFileSync(
		command,
		[
			'#!/usr/bin/env node',
			"const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');",
			"const base = config.providers?.['surface-probe']?.settings?.baseURL;",
			// oxlint-disable-next-line eslint/no-template-curly-in-string -- The text is generated fixture source; the placeholder interpolates only when that script runs.
			"await fetch(`${base}/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({tools: []})});",
			'',
		].join('\n'),
		{encoding: 'utf8', mode: 0o755},
	);

	await assert.rejects(capturePresentedTools({workspace, surface, command, timeoutMs: 30_000}), /observed no tool-bearing request/u);
});
