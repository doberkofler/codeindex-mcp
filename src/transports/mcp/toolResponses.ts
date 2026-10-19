import {type CallToolResult} from '@modelcontextprotocol/server';
import {type ErrorCodeType, isCodeIndexError} from '../../core/errors/errors.ts';
import {debugFor} from '../../core/logging/debug.ts';

const debug = debugFor('mcp');
const SUCCESS_ENVELOPE_OVERHEAD_BYTES = Buffer.byteLength(JSON.stringify({ok: true, data: null}), 'utf8') - Buffer.byteLength('null', 'utf8');
const INTERNAL_ERROR_MESSAGE = 'Internal index failure';

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

	return failureEnvelope('internal_error', INTERNAL_ERROR_MESSAGE);
};

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Builds the largest failure envelope whose message fits the response bound.
 *
 * @param code - Stable error code.
 * @param message - Preferred message; shortened when the envelope would exceed the bound.
 * @param maxResultBytes - Maximum serialized UTF-8 bytes.
 * @returns A failure envelope and its serialized text.
 */
const boundedFailureEnvelope = (code: ErrorCodeType, message: string, maxResultBytes: number): Readonly<{envelope: ToolEnvelopeType; text: string}> => {
	const serialize = (candidate: string): Readonly<{envelope: ToolEnvelopeType; text: string}> => {
		const envelope = failureEnvelope(code, candidate);
		return {envelope, text: JSON.stringify(envelope)};
	};
	const full = serialize(message);

	if (byteLength(full.text) <= maxResultBytes) {
		return full;
	}

	let low = 0;
	let high = message.length;

	while (low < high) {
		const middle = Math.ceil((low + high) / 2);

		if (byteLength(serialize(message.slice(0, middle)).text) <= maxResultBytes) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}

	return serialize(message.slice(0, low));
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
 * @throws {never} Never. Oversized responses become bounded `response_too_large`
 * envelopes that tell the caller to reduce the limit.
 */
export const toCallToolResult = (
	envelope: ToolEnvelopeType,
	maxResultBytes: number,
): Readonly<{result: CallToolResult; bytes: number; itemCount: number | null}> => {
	let selected = envelope;
	let text = JSON.stringify(envelope);
	const initialBytes = byteLength(text);

	if (initialBytes > maxResultBytes) {
		debug('response oversized', {bytes: initialBytes, maxResultBytes});
		const bounded = boundedFailureEnvelope(
			'response_too_large',
			`Response exceeded ${maxResultBytes} bytes; request a smaller limit or read fewer symbols`,
			maxResultBytes,
		);
		const {envelope: boundedEnvelope, text: boundedText} = bounded;
		selected = boundedEnvelope;
		text = boundedText;
	}

	const isError = !selected.ok;

	return {
		result: {
			content: [{type: 'text', text}],
			structuredContent: selected,
			isError,
		},
		bytes: byteLength(text),
		itemCount: countItems(selected),
	};
};
