import {antlrOracleParserBinding} from './antlrBinding.ts';
import {createOracleExtractor} from './index.ts';

/**
 * Qualification-only Oracle extractor bound to the pinned ANTLR parser.
 *
 * Production never imports this module. Qualification loads it dynamically so
 * MCP and default CLI builds keep only the structural parser.
 */
export const antlrOracleExtractor = createOracleExtractor(antlrOracleParserBinding);
