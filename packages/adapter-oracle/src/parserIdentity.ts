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

const ORACLE_GRAMMAR_REVISION = 'grammars-v4/3f1ca793eb1b72d421a016dd05b1d340dfa1a65e';
const ORACLE_RUNTIME_VERSION = 'antlr4ng@3.0.16';

const IDENTITIES: Readonly<Record<OracleParserIdType, OracleParserIdentityType>> = {
	structural: {
		id: 'structural',
		revision: `structural@5;lexer@${ORACLE_RUNTIME_VERSION};lexerGrammar@${ORACLE_GRAMMAR_REVISION}`,
		compilerVersion: `oracle19c;parser@structural;lexer@${ORACLE_RUNTIME_VERSION};lexerGrammar@${ORACLE_GRAMMAR_REVISION}`,
	},
	antlr: {
		id: 'antlr',
		revision: `antlr@2;runtime@${ORACLE_RUNTIME_VERSION};grammar@${ORACLE_GRAMMAR_REVISION}`,
		compilerVersion: `oracle19c;parser@antlr;runtime@${ORACLE_RUNTIME_VERSION};grammar@${ORACLE_GRAMMAR_REVISION}`,
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
