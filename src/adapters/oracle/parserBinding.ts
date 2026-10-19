import {type ConfigType} from '../../core/config/config.ts';
import {structuralOracleParser} from './parseUnits.ts';
import {oracleParserIdentityOf, parseOracleParserId, type OracleParserIdType, type OracleParserIdentityType} from './parserIdentity.ts';
import {type OracleParserType} from './syntax.ts';

const ORACLE_PARSER_OPTION = 'oracleParser';

/**
 * One parser implementation and its serializable identity.
 *
 * Bindings are closed over by the extractor factory so parser selection cannot
 * drift between scanning and extraction.
 */
export type OracleParserBindingType = Readonly<{
	identity: OracleParserIdentityType;
	parser: OracleParserType;
}>;

/** Production binding: the structural scanner remains authoritative. */
export const structuralOracleParserBinding: OracleParserBindingType = {
	identity: oracleParserIdentityOf('structural'),
	parser: structuralOracleParser,
};

/**
 * Reads the parser selected by configuration.
 *
 * Production defaults to the structural parser. The ANTLR parser is only bound
 * by the qualification candidate extractor.
 *
 * @param config - Resolved adapter configuration.
 * @returns The selected parser identifier.
 * @throws {@link Error} When the configured value is not a known parser.
 */
export const oracleParserIdOfConfig = (config: ConfigType): OracleParserIdType => {
	const configured = config.extractorOptions[ORACLE_PARSER_OPTION];

	if (configured === undefined) {
		return 'structural';
	}

	if (typeof configured !== 'string') {
		throw new TypeError(`Oracle parser option must be a string: ${ORACLE_PARSER_OPTION}`);
	}

	return parseOracleParserId(configured);
};

/**
 * Rejects a configuration whose parser selection does not match the bound
 * extractor. This prevents generating structural facts under ANTLR identity or
 * the reverse.
 *
 * @param config - Resolved adapter configuration.
 * @param binding - Parser bound to the extractor.
 * @throws {@link Error} When the configured parser differs from the binding.
 */
export const assertOracleParserBinding = (config: ConfigType, binding: OracleParserBindingType): void => {
	const selected = oracleParserIdOfConfig(config);

	if (selected !== binding.identity.id) {
		throw new Error(`Oracle parser configuration selects ${selected}, but the extractor is bound to ${binding.identity.id}`);
	}
};

/**
 * Returns a configuration pinned to one parser implementation.
 *
 * @param config - Resolved adapter configuration.
 * @param parser - Parser identifier to pin.
 * @returns A copy whose extractor options select the requested parser.
 */
export const configForOracleParser = (config: ConfigType, parser: OracleParserIdType): ConfigType => ({
	...config,
	extractorOptions: {...config.extractorOptions, [ORACLE_PARSER_OPTION]: parser},
});
