import {describe, expect, it} from 'vitest';
import {readSymbolSource} from '../src/core/query/readSymbolSource.ts';

const read = (content: string, maxResultBytes: number, symbolEndLine = 1): ReturnType<typeof readSymbolSource> =>
	readSymbolSource({content, symbolStartLine: 1, symbolEndLine, contextLines: 0, maxReadLines: 100, maxResultBytes});

describe('readSymbolSource', () => {
	it('truncates multi-byte characters without splitting code points', () => {
		const result = read('😀'.repeat(10), 10);

		expect(result.source).toBe('😀😀');
		expect(result.source).not.toContain('\uFFFD');
		expect(result.truncatedReason).toBe('bytes');
	});

	it('reserves serialized escape overhead instead of raw source bytes', () => {
		const result = read('\t'.repeat(10), 8);

		expect(result.source).toBe('\t'.repeat(4));
		expect(Buffer.byteLength(JSON.stringify(result.source), 'utf8') - 2).toBeLessThanOrEqual(8);
		expect(result.truncatedReason).toBe('bytes');
	});

	it('keeps complete lines when the byte budget allows them', () => {
		const result = read('first\nsecond\nthird', 13, 3);

		expect(result.source).toBe('first\nsecond');
		expect(result.endLine).toBe(2);
		expect(result.truncatedReason).toBe('bytes');
	});
});
