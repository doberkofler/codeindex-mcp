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

	it('shortens error messages to a tiny response budget', () => {
		const tiny = toCallToolResult(errorEnvelope(new CodeIndexError('invalid_argument', 'detail')), 10);
		const truncated = toCallToolResult(errorEnvelope(new CodeIndexError('invalid_argument', 'detail '.repeat(100))), 100);

		expect(tiny.result.isError).toBe(true);
		expect(tiny.result.structuredContent).toMatchObject({ok: false, error: {code: 'response_too_large'}});
		expect(truncated.result.isError).toBe(true);
		expect(truncated.result.structuredContent).toMatchObject({
			ok: false,
			error: {code: 'response_too_large', message: expect.stringContaining('Response exceeded 100 bytes')},
		});
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
