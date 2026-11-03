import {formatter as defaults} from './oxc.config.ts';

// Project-specific Oxfmt overrides.
const formatter: Partial<typeof defaults> = {};

const config = {
	...defaults,
	...formatter,
	// Generated parser output and the verbatim upstream lexer/parser bases keep
	// their upstream bytes; generated code is reproducible from the pinned grammar.
	ignorePatterns: [
		...defaults.ignorePatterns,
		'packages/adapter-oracle/src/generated/**',
		'packages/adapter-oracle/src/plSqlLexerBase.ts',
		'packages/adapter-oracle/src/plSqlParserBase.ts',
	],
};

export default config;
