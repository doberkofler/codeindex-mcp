import {parseOracleDeclarations} from './parseDeclarations.ts';
import {type OracleParseInputType, type OracleParseResultType, type OracleParserType} from './syntax.ts';
import {tokenizeOracleSource, type OracleTokenType} from './tokenize.ts';

/**
 * Parses one Oracle source file into compact declaration and name-site records.
 *
 * @param input - Visible and hidden tokens, workspace path, and manifest schema.
 * @returns Structural facts for one file.
 */
export const parseOracleUnits = (input: Readonly<{tokens: readonly OracleTokenType[]; path: string; defaultSchema: string}>): OracleParseResultType =>
	parseOracleDeclarations(input);

/**
 * Structural parser bound to the language-neutral parser seam.
 *
 * Tokenization happens inside the seam so both parser implementations accept
 * the same input contract. Token diagnostics precede parser diagnostics, which
 * preserves the adapter's historical diagnostic order.
 *
 * @param input - Source text, workspace path, and default schema.
 * @returns Structural facts for one file.
 */
export const structuralOracleParser: OracleParserType = (input: OracleParseInputType): OracleParseResultType => {
	const tokenized = tokenizeOracleSource(input.source, input.path);
	const parsed = parseOracleUnits({tokens: tokenized.tokens, path: input.path, defaultSchema: input.defaultSchema});

	return {...parsed, diagnostics: [...tokenized.diagnostics, ...parsed.diagnostics]};
};
