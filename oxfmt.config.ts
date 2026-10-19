import {formatter as defaults} from './oxc.config.ts';

// Project-specific Oxfmt overrides.
const formatter: Partial<typeof defaults> = {};

const config = {
	...defaults,
	...formatter,
	// Generated lexer output and the verbatim upstream lexer base keep their
	// upstream bytes; generated code is reproducible from the pinned grammar.
	ignorePatterns: [...defaults.ignorePatterns, 'src/adapters/oracle/generated/**', 'src/adapters/oracle/plSqlLexerBase.ts'],
};

export default config;
