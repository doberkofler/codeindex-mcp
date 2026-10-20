import {describe, expect, it} from 'vitest';
import {readSymbolResult} from '../src/core/query/readSymbolResult.ts';
import {type SymbolSummaryType} from '../src/core/model.ts';

const symbol: SymbolSummaryType = {
	id: 'symbol',
	name: 'run',
	qualifiedName: 'demo.run',
	kind: 'function',
	path: 'src/demo.ts',
	startLine: 1,
	endLine: 2,
	startColumn: 1,
	endColumn: 1,
	enclosingId: null,
	startOffset: 0,
	endOffset: 10,
	contexts: ['root'],
};

const site = {
	siteId: 'o_site',
	path: 'src/demo.ts',
	nameStart: 0,
	nameEnd: 3,
	extentStart: 0,
	extentEnd: 11,
	startLine: 1,
	endLine: 2,
	declarationKind: 'function',
	forwardDefinition: false,
	primary: true,
	identityAnchor: true,
};

const freshness = {state: 'current' as const, checkedAt: '2026-01-01T00:00:00.000Z', dirtyFileCount: null};

describe('read symbol result', () => {
	it('returns the selected source within the result budget', () => {
		const result = readSymbolResult({
			content: 'line1\nline2\nline3',
			symbol,
			site,
			generationId: 'generation',
			freshness,
			contextLines: 0,
			maxReadLines: 10,
			maxResultBytes: 1000,
		});

		expect(result).toMatchObject({
			generationId: 'generation',
			path: 'src/demo.ts',
			startLine: 1,
			endLine: 2,
			source: 'line1\nline2',
			truncated: false,
			truncatedReason: null,
		});
	});

	it('drops source when the metadata alone exceeds the budget', () => {
		const result = readSymbolResult({
			content: 'line1\nline2\nline3',
			symbol,
			site,
			generationId: 'generation',
			freshness,
			contextLines: 0,
			maxReadLines: 10,
			maxResultBytes: 1,
		});

		expect(result).toMatchObject({source: '', truncated: true, truncatedReason: 'bytes'});
		expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeGreaterThan(1);
	});
});
