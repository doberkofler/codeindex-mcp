import {type CallToolResult} from '@modelcontextprotocol/server';
import {type ErrorCodeType, isCodeIndexError} from '../../core/errors/errors.ts';
import {debugFor} from '../../core/logging/debug.ts';

const debug = debugFor('mcp');
const SUCCESS_ENVELOPE_OVERHEAD_BYTES = Buffer.byteLength(JSON.stringify({ok: true, data: null}), 'utf8') - Buffer.byteLength('null', 'utf8');

export type ToolEnvelopeType = Readonly<{ok: true; data: unknown}> | Readonly<{ok: false; error: Readonly<{code: ErrorCodeType; message: string}>}>;

export const successEnvelope = (data: unknown): ToolEnvelopeType => ({ok: true, data});

/**
 * Converts a complete MCP response budget into the budget available to data.
 *
 * @param maxResultBytes - Maximum serialized success-envelope size.
 * @returns Bytes available after the fixed success-envelope framing.
 */
export const successDataBudget = (maxResultBytes: number): number => Math.max(1, maxResultBytes - SUCCESS_ENVELOPE_OVERHEAD_BYTES);
const failureEnvelope = (code: ErrorCodeType, message: string): ToolEnvelopeType => ({ok: false, error: {code, message}});

/**
 * Maps an expected index failure to a stable error envelope.
 *
 * Unexpected errors are reduced to `internal_error` so stack traces and
 * filesystem details never reach the model.
 * @param error - Error thrown by a tool implementation.
 * @returns A stable error envelope; unexpected errors become `internal_error`.
 */
export const errorEnvelope = (error: unknown): ToolEnvelopeType => {
	if (isCodeIndexError(error)) {
		return failureEnvelope(error.code, error.message);
	}

	return failureEnvelope('internal_error', error instanceof Error ? error.message : 'Unknown index failure');
};

const countItems = (envelope: ToolEnvelopeType): number | null => {
	if (!envelope.ok || typeof envelope.data !== 'object' || envelope.data === null) {
		return null;
	}

	const {items} = envelope.data as {items?: unknown};
	return Array.isArray(items) ? items.length : null;
};

/**
 * Serializes one envelope and enforces the configured response bound.
 *
 * @param envelope - Tool result envelope.
 * @param maxResultBytes - Maximum serialized UTF-8 bytes.
 * @returns The MCP result, serialized byte count, and item count.
 * @throws {never} Never. Oversized successful responses become `response_too_large`
 * envelopes that tell the caller to reduce the limit.
 */
export const toCallToolResult = (
	envelope: ToolEnvelopeType,
	maxResultBytes: number,
): Readonly<{result: CallToolResult; bytes: number; itemCount: number | null}> => {
	let selected = envelope;
	let text = JSON.stringify(envelope);

	if (envelope.ok && Buffer.byteLength(text, 'utf8') > maxResultBytes) {
		debug('response oversized', {bytes: Buffer.byteLength(text, 'utf8'), maxResultBytes});
		selected = failureEnvelope('response_too_large', `Response exceeded ${maxResultBytes} bytes; request a smaller limit or read fewer symbols`);
		text = JSON.stringify(selected);
	}

	const isError = !selected.ok;

	return {
		result: {
			content: [{type: 'text', text}],
			structuredContent: selected,
			isError,
		},
		bytes: Buffer.byteLength(text, 'utf8'),
		itemCount: countItems(selected),
	};
};
