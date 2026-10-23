import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {assertRequestOneSurface, duplicateToolNamesOf, surfaceRequestLedgerOf, type SurfaceRequestType} from './requestSurface.ts';
import {presentedToolsOf} from './surface.ts';
import {toolSurfaceOf, treatmentOf} from './treatment.ts';

const ORDINARY = ['bash', 'edit', 'glob', 'grep', 'list', 'read'];

const indexedSurface = toolSurfaceOf(
	treatmentOf({
		id: 'accepted',
		kind: 'codeindex',
		ordinaryTools: ORDINARY,
		codeMode: 'absent',
		artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
		mcp: {server: 'codeindex', codemode: false},
	}),
	['find_symbol', 'read_symbol'],
);

const plainSurface = toolSurfaceOf(
	treatmentOf({
		id: 'no-index',
		kind: 'no-index',
		ordinaryTools: ORDINARY,
		codeMode: 'absent',
		artifact: null,
		mcp: null,
	}),
);

const requestOf = (ordinal: number, kind: SurfaceRequestType['kind'], toolNames: readonly string[]): SurfaceRequestType => ({ordinal, kind, toolNames});

describe('requestSurface', () => {
	it('accepts the exact indexed surface on agent request 1', () => {
		const ledger = assertRequestOneSurface(indexedSurface, [requestOf(1, 'title', []), requestOf(2, 'agent', presentedToolsOf(indexedSurface))]);

		assert.equal(ledger.result, 'pass');
		assert.equal(ledger.cause, null);
		assert.equal(ledger.firstAgentRequest?.ordinal, 2);
		assert.equal(ledger.titleRequests, 1);
		assert.deepEqual(ledger.differences, []);
	});

	it('accepts the ordinary-only surface on no-index request 1', () => {
		const ledger = assertRequestOneSurface(plainSurface, [requestOf(1, 'agent', presentedToolsOf(plainSurface))]);

		assert.equal(ledger.result, 'pass');
		assert.deepEqual(ledger.declared, presentedToolsOf(plainSurface));
	});

	it('rejects an indexed tool that first appears on agent request 2', () => {
		const exact = presentedToolsOf(indexedSurface);
		const withoutIndex = exact.filter((name) => !name.startsWith('codeindex_'));

		const ledger = surfaceRequestLedgerOf(indexedSurface, [requestOf(1, 'agent', withoutIndex), requestOf(2, 'agent', exact)]);

		assert.equal(ledger.result, 'fail');
		assert.equal(ledger.cause, 'late-surface');
		assert.match(ledger.differences.join('\n'), /declared tool codeindex_find_symbol is not presented/u);
	});

	it('rejects a duplicate tool on agent request 1', () => {
		const ledger = surfaceRequestLedgerOf(indexedSurface, [requestOf(1, 'agent', [...presentedToolsOf(indexedSurface), 'read'])]);

		assert.equal(ledger.result, 'fail');
		assert.equal(ledger.cause, 'duplicate-tools');
		assert.deepEqual(duplicateToolNamesOf(['read', 'edit', 'read', 'edit']), ['edit', 'read']);
	});

	it('rejects an unknown tool on agent request 1', () => {
		const ledger = surfaceRequestLedgerOf(indexedSurface, [requestOf(1, 'agent', [...presentedToolsOf(indexedSurface), 'webfetch'])]);

		assert.equal(ledger.result, 'fail');
		assert.equal(ledger.cause, 'unknown-tools');
		assert.match(ledger.differences.join('\n'), /undeclared tool webfetch is presented/u);
	});

	it('rejects any CodeIndex tool in the no-index treatment', () => {
		const ledger = surfaceRequestLedgerOf(plainSurface, [requestOf(1, 'agent', [...presentedToolsOf(plainSurface), 'codeindex_find_symbol'])]);

		assert.equal(ledger.result, 'fail');
		assert.equal(ledger.cause, 'codeindex-in-no-index');
	});

	it('rejects a provider request that discloses the primary checkout path', () => {
		const request = {...requestOf(1, 'agent', presentedToolsOf(indexedSurface)), pathDisclosureCount: 1};
		const ledger = surfaceRequestLedgerOf(indexedSurface, [request]);

		assert.equal(ledger.result, 'fail');
		assert.equal(ledger.cause, 'path-disclosure');
		assert.match(ledger.differences.join('\n'), /provider request 1 \(agent\) discloses/u);
	});

	it('rejects an agent request with no tools and a probe with no agent request', () => {
		const empty = surfaceRequestLedgerOf(indexedSurface, [requestOf(1, 'agent', [])]);
		const absent = surfaceRequestLedgerOf(indexedSurface, [requestOf(1, 'title', [])]);

		assert.equal(empty.cause, 'empty-agent-request');
		assert.equal(absent.cause, 'no-agent-request');
	});

	it('throws a closed cause instead of returning a failed ledger', () => {
		assert.throws(
			() =>
				assertRequestOneSurface(indexedSurface, [
					requestOf(1, 'agent', presentedToolsOf(plainSurface)),
					requestOf(2, 'agent', presentedToolsOf(indexedSurface)),
				]),
			{name: 'SurfaceReadinessError', message: /late-surface/u},
		);
	});
});
