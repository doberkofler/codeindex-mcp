import {BaseErrorListener, CharStream, CommonTokenStream, Token} from 'antlr4ng';
import {type DiagnosticType} from '../../core/model.ts';
import {ORACLE_DIAGNOSTIC, OracleDiagnosticCollector} from './diagnostics.ts';
import {endPositionOf} from './sourceLocation.ts';
import {PlSqlLexer} from './generated/PlSqlLexer.ts';

export type OracleTokenType = Readonly<{
	kind: number;
	text: string;
	channel: 'visible' | 'hidden';
	startOffset: number;
	endOffset: number;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}>;

export type TokenizationResultType = Readonly<{
	tokens: readonly OracleTokenType[];
	diagnostics: readonly DiagnosticType[];
}>;

class OracleLexerErrorListener extends BaseErrorListener {
	readonly #report: (line: number, column: number, message: string) => void;

	public constructor(report: (line: number, column: number, message: string) => void) {
		super();
		this.#report = report;
	}

	public override syntaxError(...args: Parameters<BaseErrorListener['syntaxError']>): void {
		const {2: line, 3: column, 4: message} = args;
		this.#report(line, column, message);
	}
}

/**
 * Tokenizes one Oracle source file and releases every ANTLR object.
 *
 * Hidden-channel whitespace and comments are retained so callers can decide
 * whether a token boundary matters. No ANTLR type crosses this module.
 *
 * @param source - Raw UTF-16 source text.
 * @param path - Workspace-relative POSIX path used for diagnostics.
 * @returns Compact tokens and bounded lexer diagnostics.
 */
export const tokenizeOracleSource = (source: string, path: string): TokenizationResultType => {
	const collector = new OracleDiagnosticCollector(path);
	const input = CharStream.fromString(source);
	const lexer = new PlSqlLexer(input);
	lexer.removeErrorListeners();
	lexer.addErrorListener(
		new OracleLexerErrorListener((line, column, message) => {
			collector.add(ORACLE_DIAGNOSTIC.lexer, message, line, column + 1);
		}),
	);
	const stream = new CommonTokenStream(lexer);
	stream.fill();
	const tokens: OracleTokenType[] = [];

	for (const token of stream.getTokens()) {
		if (token.type === Token.EOF || token.start < 0) {
			continue;
		}

		const text = token.text ?? source.slice(token.start, token.stop + 1);
		const end = endPositionOf(text, token.line, token.column + 1);

		tokens.push({
			kind: token.type,
			text,
			channel: token.channel === Token.HIDDEN_CHANNEL ? 'hidden' : 'visible',
			startOffset: token.start,
			endOffset: token.stop + 1,
			startLine: token.line,
			startColumn: token.column + 1,
			endLine: end.line,
			endColumn: end.column,
		});
	}

	return {tokens, diagnostics: collector.finish()};
};
