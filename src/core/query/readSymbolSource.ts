type ReadSymbolSourceInputType = Readonly<{
	content: string;
	symbolStartLine: number;
	symbolEndLine: number;
	contextLines: number;
	maxReadLines: number;
	/** Maximum UTF-8 bytes for the JSON-serialized source string, excluding its quotes. */
	maxResultBytes: number;
}>;

export type ReadSymbolSourceType = Readonly<{
	startLine: number;
	endLine: number;
	source: string;
	truncatedReason: 'lines' | 'bytes' | null;
}>;

/**
 * Returns the UTF-8 size of one string as it appears inside a JSON string literal.
 *
 * The surrounding quotes are excluded so callers can reserve only the value's
 * bytes. Control characters count with their escape sequence.
 *
 * @param value - String fragment to measure.
 * @returns Serialized UTF-8 byte length without the two quotes.
 */
const serializedByteLength = (value: string): number => Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;

/**
 * Keeps the largest prefix whose JSON-serialized UTF-8 size fits the budget.
 *
 * Iteration is by code point, so a multi-byte character is never split and the
 * result never contains replacement characters caused by truncation.
 *
 * @param value - Source text to shorten.
 * @param maxBytes - Maximum serialized UTF-8 bytes, excluding string quotes.
 * @returns The longest prefix that fits the budget.
 */
const truncateToSerializedBytes = (value: string, maxBytes: number): string => {
	let selected = '';
	let bytes = 0;

	for (const character of value) {
		const characterBytes = serializedByteLength(character);

		if (bytes + characterBytes > maxBytes) {
			break;
		}

		bytes += characterBytes;
		selected += character;
	}

	return selected;
};

export const readSymbolSource = (input: ReadSymbolSourceInputType): ReadSymbolSourceType => {
	const lines = input.content.split('\n');
	const contextLines = Math.max(0, input.contextLines);
	const firstLine = Math.max(1, input.symbolStartLine - contextLines);
	const requestedLastLine = Math.min(lines.length, input.symbolEndLine + contextLines);
	const maximumLastLine = Math.min(requestedLastLine, firstLine + input.maxReadLines - 1);
	let lastLine = maximumLastLine;
	let reason: 'lines' | 'bytes' | null = lastLine < requestedLastLine ? 'lines' : null;

	const slice = (): string => lines.slice(firstLine - 1, lastLine).join('\n');
	let source = slice();

	while (serializedByteLength(source) > input.maxResultBytes && lastLine > firstLine) {
		lastLine -= 1;
		reason = 'bytes';
		source = slice();
	}

	if (serializedByteLength(source) > input.maxResultBytes) {
		reason = 'bytes';
		source = truncateToSerializedBytes(source, input.maxResultBytes);
	}

	return {startLine: firstLine, endLine: lastLine, source, truncatedReason: reason};
};
