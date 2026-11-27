/** Parser implementations that can be bound to the Oracle adapter seam. */
export type OracleParserIdType = 'structural' | 'antlr';

/**
 * Serializable parser identity.
 *
 * `compilerVersion` is persisted with every generation. `revision` is folded
 * into the configuration hash so generations cannot be reused across parser
 * implementations.
 */
export type OracleParserIdentityType = Readonly<{
	id: OracleParserIdType;
	revision: string;
	compilerVersion: string;
}>;

const ORACLE_PARSER_IDS: readonly OracleParserIdType[] = ['structural', 'antlr'];

// The lexer is byte-identical at the parser pin; keep its identity to reuse structural indexes.
const ORACLE_LEXER_GRAMMAR_REVISION = 'grammars-v4/c306207ac870e7c5a95763b518ba3e3a1ca61409';
const ORACLE_PARSER_GRAMMAR_REVISION = 'grammars-v4/de38599628d221099c046e92962f70204d852b54';
const ORACLE_RUNTIME_VERSION = 'antlr4ng@3.0.16';

const IDENTITIES: Readonly<Record<OracleParserIdType, OracleParserIdentityType>> = {
	structural: {
		id: 'structural',
		revision: `structural@6;lexer@${ORACLE_RUNTIME_VERSION};lexerGrammar@${ORACLE_LEXER_GRAMMAR_REVISION}`,
		compilerVersion: `oracle19c;parser@structural;lexer@${ORACLE_RUNTIME_VERSION};lexerGrammar@${ORACLE_LEXER_GRAMMAR_REVISION}`,
	},
	antlr: {
		id: 'antlr',
		revision: `antlr@2;runtime@${ORACLE_RUNTIME_VERSION};grammar@${ORACLE_PARSER_GRAMMAR_REVISION}`,
		compilerVersion: `oracle19c;parser@antlr;runtime@${ORACLE_RUNTIME_VERSION};grammar@${ORACLE_PARSER_GRAMMAR_REVISION}`,
	},
};

/**
 * Resolves one parser identity.
 *
 * @param id - Parser implementation identifier.
 * @returns The immutable identity persisted with generations.
 */
export const oracleParserIdentityOf = (id: OracleParserIdType): OracleParserIdentityType => IDENTITIES[id];

/**
 * Validates a parser identifier from configuration or a command line.
 *
 * @param value - Untrusted parser name.
 * @returns The matching parser identifier.
 * @throws {@link Error} When the parser is unknown.
 */
export const parseOracleParserId = (value: string): OracleParserIdType => {
	if (value !== 'structural' && value !== 'antlr') {
		throw new Error(`Unknown Oracle parser: ${value}. Expected one of: ${ORACLE_PARSER_IDS.join(', ')}`);
	}

	return value;
};
