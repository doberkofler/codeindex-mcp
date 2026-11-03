import {antlrOracleParser} from './antlrParser.ts';
import {type OracleParserBindingType} from './parserBinding.ts';
import {oracleParserIdentityOf} from './parserIdentity.ts';

/**
 * Qualification-only binding for the pinned ANTLR parser.
 *
 * This module is loaded dynamically so production bundles never import the
 * generated ANTLR parser.
 */
export const antlrOracleParserBinding: OracleParserBindingType = {
	identity: oracleParserIdentityOf('antlr'),
	parser: antlrOracleParser,
};
