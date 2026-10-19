import {describe, expect, it} from 'vitest';
import {CodeIndexError} from '../src/core/errors/codeIndexError.ts';
import {errorEnvelope, toCallToolResult} from '../src/transports/mcp/toolResponses.ts';

describe('MCP tool response envelopes', () => {
	it('does not expose unexpected error messages', () => {
		const envelope = errorEnvelope(new Error('open /Users/secret/workspace.ts with token abc123'));

		expect(envelope).toStrictEqual({ok: false, error: {code: 'internal_error', message: 'Internal index failure'}});
	});

	it('preserves expected index errors', () => {
		const envelope = errorEnvelope(new CodeIndexError('invalid_argument', 'Invalid cursor'));

		expect(envelope).toStrictEqual({ok: false, error: {code: 'invalid_argument', message: 'Invalid cursor'}});
	});

	it('bounds oversized error envelopes', () => {
		const maxResultBytes = 256;
		const envelope = errorEnvelope(new CodeIndexError('invalid_argument', 'detail '.repeat(1000)));
		const response = toCallToolResult(envelope, maxResultBytes);

		expect(response.bytes).toBeLessThanOrEqual(maxResultBytes);
		expect(response.result.isError).toBe(true);
		expect(response.result.structuredContent).toMatchObject({ok: false, error: {code: 'response_too_large'}});
	});
});
