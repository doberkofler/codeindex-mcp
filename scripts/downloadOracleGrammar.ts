import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const UPSTREAM_COMMIT = 'e199816b3f1a7a49ea1ad84fb6b87c382ea36a33';
const UPSTREAM_PATH = 'sql/plsql/PlSqlLexer.g4';
const UPSTREAM_SHA256 = 'fd82384ba3ba2f5a7b070a977cd77a05c01fefbfb52938d35dfaf472a2e6e59e';
const URL = `https://raw.githubusercontent.com/antlr/grammars-v4/${UPSTREAM_COMMIT}/${UPSTREAM_PATH}`;
const HEADER_MARKER = '// Insert here @header for C++ lexer.';
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

const adaptGrammar = (upstream: string): string => {
	const withHeader = replaceExactlyOnce(upstream, HEADER_MARKER, HEADER_ADAPTATION, 'target-language header marker');

	return replaceExactlyOnce(withHeader, UPSTREAM_Q_STRING, ADAPTED_Q_STRING, 'alternative-quoted string rule');
};

const download = async (): Promise<void> => {
	const response = await fetch(URL);

	if (!response.ok) {
		throw new Error(`Unable to download Oracle grammar: ${response.status} ${response.statusText}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	const digest = createHash('sha256').update(bytes).digest('hex');

	if (digest !== UPSTREAM_SHA256) {
		throw new Error(`Oracle grammar digest mismatch: expected ${UPSTREAM_SHA256}, received ${digest}`);
	}

	const directory = path.resolve(import.meta.dirname, '..', 'grammar', 'oracle');
	const target = path.join(directory, 'PlSqlLexer.g4');

	mkdirSync(directory, {recursive: true});
	writeFileSync(target, adaptGrammar(bytes.toString('utf8')));
	process.stdout.write(`Wrote adapted Oracle lexer grammar to ${target}\n`);
};

await download();
