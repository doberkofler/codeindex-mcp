import {describe, expect, it} from 'vitest';
import {toolGuidanceOf} from '../src/transports/mcp/toolGuidance.ts';

const current = {state: 'current'};

describe('tool guidance', () => {
	it('stops after a current, non-empty, untruncated result', () => {
		expect(toolGuidanceOf('find_symbol', {items: [{symbolId: 'symbol'}], freshness: current, truncated: false, nextCursor: null})).toStrictEqual({
			action: 'stop',
			fallbackRequired: false,
			message: 'Complete result; no fallback search is required.',
		});
		expect(toolGuidanceOf('read_symbol', {kind: 'text', source: 'export const value = 1;', freshness: current})).toMatchObject({action: 'stop'});
		expect(toolGuidanceOf('symbol_at', {candidates: [{symbol: {id: 'symbol'}}], freshness: current})).toMatchObject({action: 'stop'});
	});

	it('requires the next cursor before answering a truncated page', () => {
		expect(toolGuidanceOf('find_symbol', {items: [{symbolId: 'symbol'}], freshness: current, truncated: true, nextCursor: 'cursor'})).toMatchObject({
			action: 'follow_cursor',
			fallbackRequired: false,
		});
	});

	it('requires a text search for no stored match or an empty result', () => {
		expect(toolGuidanceOf('find_references', {kind: 'none', message: 'No stored symbol matched.'})).toStrictEqual({
			action: 'text_search',
			fallbackRequired: true,
			message: 'No stored match; this is not evidence of absence. Use a repository text search as the fallback.',
		});
		expect(toolGuidanceOf('find_symbol', {items: [], freshness: current, truncated: false})).toMatchObject({
			action: 'text_search',
			fallbackRequired: true,
		});
	});

	it('refines an ambiguous query instead of falling back', () => {
		expect(toolGuidanceOf('find_references', {kind: 'ambiguous', candidates: [{symbolId: 'symbol'}]})).toMatchObject({
			action: 'refine',
			fallbackRequired: false,
		});
	});

	it('does not call stale, unknown, or updating results authoritative', () => {
		const items = [{symbolId: 'symbol'}];

		expect(toolGuidanceOf('find_symbol', {items, freshness: {state: 'stale'}})).toMatchObject({action: 'text_search', fallbackRequired: true});
		expect(toolGuidanceOf('find_symbol', {items, freshness: {state: 'unknown'}})).toMatchObject({action: 'text_search', fallbackRequired: true});
		expect(toolGuidanceOf('find_symbol', {items, freshness: {state: 'updating'}})).toMatchObject({action: 'retry', fallbackRequired: false});
	});

	it('leaves status without answer guidance', () => {
		expect(toolGuidanceOf('index_status', {ready: true, counts: {files: 1}, freshness: current})).toBeNull();
	});
});
