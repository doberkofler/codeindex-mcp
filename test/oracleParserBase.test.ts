import {Token, type TokenStream} from 'antlr4ng';
import {describe, expect, it} from 'vitest';
import {PlSqlLexer} from '../src/adapters/oracle/generated/PlSqlLexer.ts';
import {PlSqlParser} from '../src/adapters/oracle/generated/PlSqlParser.ts';

type TokenLikeType = Readonly<{type: number; line: number}>;

class TokenStreamStub {
	readonly #tokens: readonly (TokenLikeType | null)[];
	#position: number;

	public constructor(tokens: readonly (TokenLikeType | null)[], position: number) {
		this.#tokens = tokens;
		this.#position = position;
	}

	public LT(index: number): TokenLikeType | null {
		const offset = this.#position + (index > 0 ? index - 1 : index);
		return this.#tokens[offset] ?? null;
	}

	public seek(position: number): void {
		this.#position = position;
	}
}

type TestParserType = PlSqlParser;

const parserOfTokens = (tokens: readonly (TokenLikeType | null)[], position = 0): TestParserType =>
	new PlSqlParser(new TokenStreamStub(tokens, position) as unknown as TokenStream);

const token = (type: number, line = 1): TokenLikeType => ({type, line});

const parserOf = (...tokens: readonly (TokenLikeType | null)[]): TestParserType => parserOfTokens(tokens);
const parserAt = (position: number, ...tokens: readonly (TokenLikeType | null)[]): TestParserType => parserOfTokens(tokens, position);

describe('Oracle parser base solidus separator', () => {
	it('accepts a solidus alone on its line', () => {
		expect(parserOf(token(PlSqlLexer.SOLIDUS), token(PlSqlLexer.SEMICOLON, 2)).isSolidusSeparator()).toBe(true);
		expect(parserOf(token(PlSqlLexer.SOLIDUS)).isSolidusSeparator()).toBe(true);
	});

	it('rejects every non-separator shape', () => {
		expect(parserOf(null).isSolidusSeparator()).toBe(false);
		expect(parserOf(token(PlSqlLexer.SEMICOLON)).isSolidusSeparator()).toBe(false);
		expect(parserOf(token(PlSqlLexer.SEMICOLON), token(PlSqlLexer.SOLIDUS)).isSolidusSeparator()).toBe(false);
		expect(parserAt(1, token(PlSqlLexer.SEMICOLON, 1), token(PlSqlLexer.SOLIDUS, 1)).isSolidusSeparator()).toBe(false);
		expect(parserAt(1, token(Token.EOF, 1), token(PlSqlLexer.SOLIDUS, 2)).isSolidusSeparator()).toBe(true);
		expect(parserOf(token(PlSqlLexer.SOLIDUS), token(PlSqlLexer.SEMICOLON, 1)).isSolidusSeparator()).toBe(false);
		expect(parserOf(token(PlSqlLexer.SOLIDUS), token(Token.EOF, 2)).isSolidusSeparator()).toBe(true);
	});
});

describe('Oracle parser base version predicates', () => {
	it('defaults every version to enabled and toggles independently', () => {
		const parser = parserOf(token(PlSqlLexer.SEMICOLON));

		expect([parser.isVersion10(), parser.isVersion11(), parser.isVersion12()]).toStrictEqual([true, true, true]);
		parser.setVersion10(false);
		parser.setVersion11(false);
		parser.setVersion12(false);
		expect([parser.isVersion10(), parser.isVersion11(), parser.isVersion12()]).toStrictEqual([false, false, false]);
	});
});

describe('Oracle parser base unit predicates', () => {
	it('tracks the last unit kind and resets to SQL on parser reset', () => {
		const parser = parserOf(token(PlSqlLexer.SEMICOLON));

		expect(parser.isLastUnitSql()).toBe(true);
		expect(parser.isLastUnitPlsql()).toBe(false);
		parser.setLastUnitPlsql();
		expect(parser.isLastUnitSql()).toBe(false);
		expect(parser.isLastUnitPlsql()).toBe(true);
		parser.setLastUnitSql();
		expect(parser.isLastUnitSql()).toBe(true);
		parser.setLastUnitPlsql();
		parser.reset();
		expect(parser.isLastUnitSql()).toBe(true);
	});
});

describe('Oracle parser base numeric function predicate', () => {
	it.each([PlSqlLexer.SUM, PlSqlLexer.COUNT, PlSqlLexer.AVG, PlSqlLexer.MIN, PlSqlLexer.MAX, PlSqlLexer.ROUND, PlSqlLexer.LEAST, PlSqlLexer.GREATEST])(
		'treats token %s followed by a parenthesis as a numeric function',
		(type) => {
			// oxlint-disable-next-line eslint/new-cap -- The inherited predicate keeps the upstream Oracle grammar name.
			expect(parserOf(token(type), token(PlSqlLexer.LEFT_PAREN)).IsNotNumericFunction()).toBe(false);
		},
	);

	it('accepts every other token shape as not a numeric function', () => {
		// oxlint-disable-next-line eslint/new-cap -- The inherited predicate keeps the upstream Oracle grammar name.
		expect(parserOf(token(PlSqlLexer.SUM), token(PlSqlLexer.COMMA)).IsNotNumericFunction()).toBe(true);
		// oxlint-disable-next-line eslint/new-cap -- The inherited predicate keeps the upstream Oracle grammar name.
		expect(parserOf(token(PlSqlLexer.SEMICOLON), token(PlSqlLexer.LEFT_PAREN)).IsNotNumericFunction()).toBe(true);
	});
});

describe('Oracle parser base join predicate', () => {
	it.each([PlSqlLexer.INNER, PlSqlLexer.CROSS, PlSqlLexer.NATURAL, PlSqlLexer.PARTITION, PlSqlLexer.FULL, PlSqlLexer.LEFT, PlSqlLexer.RIGHT, PlSqlLexer.OUTER])(
		'treats token %s as a join start',
		(type) => {
			expect(parserOf(token(type)).isNotStartOfJoin()).toBe(false);
		},
	);

	it('accepts a non-join token', () => {
		expect(parserOf(token(PlSqlLexer.SEMICOLON)).isNotStartOfJoin()).toBe(true);
	});
});
