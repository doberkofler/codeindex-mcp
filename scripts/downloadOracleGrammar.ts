import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const UPSTREAM_COMMIT = 'e199816b3f1a7a49ea1ad84fb6b87c382ea36a33';
const UPSTREAM_LEXER_PATH = 'sql/plsql/PlSqlLexer.g4';
const UPSTREAM_LEXER_SHA256 = 'fd82384ba3ba2f5a7b070a977cd77a05c01fefbfb52938d35dfaf472a2e6e59e';
const UPSTREAM_PARSER_PATH = 'sql/plsql/PlSqlParser.g4';
const UPSTREAM_PARSER_SHA256 = 'c57ec1819302de05beb08c44792883e159254e361e8627e981d9a3c99a0b4633';
const UPSTREAM_PARSER_BASE_PATH = 'sql/plsql/Antlr4ng/PlSqlParserBase.ts';
const UPSTREAM_PARSER_BASE_SHA256 = '240545ca222036231d7044ce468e2c4ed0d1a0ef6df190cb71a717b47faccfcb';
const UPSTREAM_URL = `https://raw.githubusercontent.com/antlr/grammars-v4/${UPSTREAM_COMMIT}`;
const HEADER_MARKER = '// Insert here @header for C++ lexer.';
const PARSER_HEADER_MARKER = '// Insert here @header for C++ parser.';
const PARSER_HEADER_ADAPTATION = '@header {import {PlSqlParserBase} from "../plSqlParserBase.js";}';
const HEADER_ADAPTATION = `@header {import {PlSqlLexerBase} from "../plSqlLexerBase.js";}

@members {
public isValidAlternativeQuotedString(): boolean {
    const characters = Array.from(this.text);
    const openingDelimiter = characters[2];
    const closingDelimiter = characters.at(-2);
    if (openingDelimiter === undefined || closingDelimiter === undefined || /\\s/u.test(openingDelimiter)) {
        return false;
    }

    switch (openingDelimiter) {
        case '[':
            return closingDelimiter === ']';
        case '{':
            return closingDelimiter === '}';
        case '<':
            return closingDelimiter === '>';
        case '(':
            return closingDelimiter === ')';
        default:
            return closingDelimiter === openingDelimiter;
    }
}
}`;
const UPSTREAM_Q_STRING = `// See https://livesql.oracle.com/apex/livesql/file/content_CIREYU9EA54EOKQ7LAMZKRF6P.html
// TODO: context sensitive string quotes (any characted after quote)
CHAR_STRING_PERL:
    'Q' '\\'' (
        QS_ANGLE
        | QS_BRACE
        | QS_BRACK
        | QS_PAREN
        | QS_EXCLAM
        | QS_SHARP
        | QS_QUOTE
        | QS_DQUOTE
        | QS_TILDA
        | QS_SOLIDUS
        | QS_RSOLIDUS
    ) '\\'' -> type(CHAR_STRING)
;
fragment QS_ANGLE    : '<' .*? '>';
fragment QS_BRACE    : '{' .*? '}';
fragment QS_BRACK    : '[' .*? ']';
fragment QS_PAREN    : '(' .*? ')';
fragment QS_EXCLAM   : '!' .*? '!';
fragment QS_SHARP    : '#' .*? '#';
fragment QS_QUOTE    : '\\'' .*? '\\'';
fragment QS_DQUOTE   : '"' .*? '"';
fragment QS_TILDA    : '~' .*? '~';
fragment QS_SOLIDUS  : '/' .*? '/';
fragment QS_RSOLIDUS : '\\\\' .*? '\\\\';`;
const ADAPTED_Q_STRING = `// See https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/Literals.html
CHAR_STRING_PERL:
    'Q' '\\'' . .*? . '\\'' {this.isValidAlternativeQuotedString()}? -> type(CHAR_STRING)
;`;

const replaceExactlyOnce = (source: string, search: string, replacement: string, description: string): string => {
	const firstIndex = source.indexOf(search);

	if (firstIndex === -1 || firstIndex !== source.lastIndexOf(search)) {
		throw new Error(`Expected exactly one ${description} in the upstream grammar`);
	}

	return source.replace(search, replacement);
};

const adaptLexerGrammar = (upstream: string): string => {
	const withHeader = replaceExactlyOnce(upstream, HEADER_MARKER, HEADER_ADAPTATION, 'target-language header marker');

	return replaceExactlyOnce(withHeader, UPSTREAM_Q_STRING, ADAPTED_Q_STRING, 'alternative-quoted string rule');
};

const adaptParserGrammar = (upstream: string): string =>
	replaceExactlyOnce(upstream, PARSER_HEADER_MARKER, PARSER_HEADER_ADAPTATION, 'parser target-language header marker');

const adaptParserBase = (upstream: string): string => {
	const withLexerImport = replaceExactlyOnce(
		upstream,
		"import { PlSqlLexer } from './PlSqlLexer.js';",
		"import { PlSqlLexer } from './generated/PlSqlLexer.js';",
		'parser base lexer import',
	);
	const withResetOverride = replaceExactlyOnce(withLexerImport, '  reset(): void {', '  override reset(): void {', 'parser base reset override');

	return replaceExactlyOnce(
		withResetOverride,
		"import { Parser, TokenStream, CommonTokenStream, Token } from 'antlr4ng';",
		"import { Parser, type TokenStream, CommonTokenStream, Token } from 'antlr4ng';",
		'parser base type-only import',
	);
};

const fetchVerified = async (sourcePath: string, expectedDigest: string): Promise<Buffer> => {
	const response = await fetch(`${UPSTREAM_URL}/${sourcePath}`);

	if (!response.ok) {
		throw new Error(`Unable to download ${sourcePath}: ${response.status} ${response.statusText}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	const digest = createHash('sha256').update(bytes).digest('hex');

	if (digest !== expectedDigest) {
		throw new Error(`${sourcePath} digest mismatch: expected ${expectedDigest}, received ${digest}`);
	}

	return bytes;
};

const download = async (): Promise<void> => {
	const [lexerBytes, parserBytes, parserBaseBytes] = await Promise.all([
		fetchVerified(UPSTREAM_LEXER_PATH, UPSTREAM_LEXER_SHA256),
		fetchVerified(UPSTREAM_PARSER_PATH, UPSTREAM_PARSER_SHA256),
		fetchVerified(UPSTREAM_PARSER_BASE_PATH, UPSTREAM_PARSER_BASE_SHA256),
	]);

	const repositoryRoot = path.resolve(import.meta.dirname, '..');
	const grammarDirectory = path.join(repositoryRoot, 'grammar', 'oracle');
	const adapterDirectory = path.join(repositoryRoot, 'src', 'adapters', 'oracle');

	mkdirSync(grammarDirectory, {recursive: true});
	writeFileSync(path.join(grammarDirectory, 'PlSqlLexer.g4'), adaptLexerGrammar(lexerBytes.toString('utf8')));
	writeFileSync(path.join(grammarDirectory, 'PlSqlParser.g4'), adaptParserGrammar(parserBytes.toString('utf8')));
	writeFileSync(path.join(adapterDirectory, 'plSqlParserBase.ts'), adaptParserBase(parserBaseBytes.toString('utf8')));

	process.stdout.write('Wrote adapted Oracle lexer grammar, parser grammar, and parser base\n');
};

await download();
