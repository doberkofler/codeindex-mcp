import {parseOracleDeclarations} from './parseDeclarations.ts';
import {type OracleParseResultType} from './syntax.ts';
import {type OracleTokenType} from './tokenize.ts';

/**
 * Parses one Oracle source file into compact declaration and name-site records.
 *
 * @param input - Visible and hidden tokens, workspace path, and manifest schema.
 * @returns Structural facts for one file.
 */
export const parseOracleUnits = (input: Readonly<{tokens: readonly OracleTokenType[]; path: string; defaultSchema: string}>): OracleParseResultType =>
	parseOracleDeclarations(input);
