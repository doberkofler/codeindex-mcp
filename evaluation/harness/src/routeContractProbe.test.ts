import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {failureProbeOf, paginationProbeOf, staleFileProbeOf, truncationProbeOf} from './routeContract.ts';
import {outcomeOf, sessionOf, tempWorkspace, writeFile} from './routeTestSupport.ts';

void test('pagination probe follows every cursor page and rejects duplicates', async () => {
	const pages = [
		{items: [{symbolId: 'a'}], truncated: true, nextCursor: 'next-1'},
		{items: [{symbolId: 'b'}], truncated: false, nextCursor: null},
	];
	let page = 0;
	const passing = sessionOf(() => {
		const data = pages[page];
		page += 1;

		return outcomeOf(data);
	});
	const passed = await paginationProbeOf(passing, {tool: 'find_symbol', arguments: {}, maxPages: 10});

	assert.equal(passed.result, 'pass');
	assert.equal(passed.observations.pages, 2);

	const duplicate = sessionOf(() => outcomeOf({items: [{symbolId: 'a'}], truncated: true, nextCursor: 'next'}));
	const failed = await paginationProbeOf(duplicate, {tool: 'find_symbol', arguments: {}, maxPages: 3});

	assert.equal(failed.result, 'fail');
});

void test('truncation probe accepts a bounded error or a shortened page and rejects an oversized success', async () => {
	const plan = {maxResultBytes: 600, tool: 'find_symbol' as const, arguments: {}};
	const boundedError = await truncationProbeOf(
		sessionOf(() => outcomeOf(null, {status: 'error', errorCode: 'response_too_large', responseBytes: 120})),
		plan,
	);
	const shortened = await truncationProbeOf(
		sessionOf(() => outcomeOf({items: [], truncated: true}, {responseBytes: 500})),
		plan,
	);
	const oversized = await truncationProbeOf(
		sessionOf(() => outcomeOf({items: [], truncated: false}, {responseBytes: 1000})),
		plan,
	);

	assert.equal(boundedError.result, 'pass');
	assert.equal(shortened.result, 'pass');
	assert.equal(oversized.result, 'fail');
});

void test('failure probe requires the declared stable code and no leaked diagnostics', async () => {
	const plan = {tool: 'find_references' as const, arguments: {}, expectedErrorCode: 'symbol_not_found'};
	const clean = await failureProbeOf(
		sessionOf(() => outcomeOf(null, {status: 'error', errorCode: 'symbol_not_found', text: 'Unknown symbol'})),
		plan,
	);
	const leaked = await failureProbeOf(
		sessionOf(() => outcomeOf(null, {status: 'error', errorCode: 'symbol_not_found', text: `Unknown symbol\n    at handler (/Users/operator/index.ts:4:1)`})),
		plan,
	);

	assert.equal(clean.result, 'pass');
	assert.equal(leaked.result, 'fail');
});

void test('stale-file probe observes refusal after a real file change and restores the workspace', async () => {
	const workspace = tempWorkspace();
	let restored = 0;

	try {
		writeFile(workspace, 'src/a.ts', 'export const value = 1;\n');
		const session = sessionOf((tool) => {
			if (tool === 'find_symbol') {
				return outcomeOf({items: [{symbolId: 'symbol-1', path: 'src/a.ts', name: 'value'}]});
			}

			const changed = readFileSync(path.join(workspace, 'src/a.ts'), 'utf8').includes('route-contract-stale-probe');

			return changed ? outcomeOf(null, {status: 'error', errorCode: 'stale_file', text: 'stale'}) : outcomeOf({items: []});
		});
		const passed = await staleFileProbeOf(session, workspace, {query: 'value', path: 'src/a.ts'}, () => {
			restored += 1;
		});

		assert.equal(passed.result, 'pass');
		assert.equal(restored, 1);

		const neverStale = await staleFileProbeOf(
			sessionOf((tool) => (tool === 'find_symbol' ? outcomeOf({items: [{symbolId: 'symbol-1', path: 'src/a.ts', name: 'value'}]}) : outcomeOf({items: []}))),
			workspace,
			{query: 'value', path: 'src/a.ts'},
			() => {
				restored += 1;
			},
		);

		assert.equal(neverStale.result, 'fail');
		assert.equal(restored, 2);
	} finally {
		rmSync(workspace, {recursive: true, force: true});
	}
});
