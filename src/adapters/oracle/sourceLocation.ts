export type OracleSourcePositionType = Readonly<{line: number; column: number}>;

/**
 * Computes the end position of a token from its text and start position.
 *
 * @param text - Token text.
 * @param startLine - One-based token start line.
 * @param startColumn - One-based token start column.
 * @returns The one-based position immediately after the token.
 */
export const endPositionOf = (text: string, startLine: number, startColumn: number): OracleSourcePositionType => {
	const lastNewline = text.lastIndexOf('\n');

	if (lastNewline === -1) {
		return {line: startLine, column: startColumn + text.length};
	}

	let line = startLine;
	let cursor = -1;

	while ((cursor = text.indexOf('\n', cursor + 1)) !== -1) {
		line += 1;
	}

	return {line, column: text.length - lastNewline};
};
