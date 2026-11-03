import {describe, expect, it} from 'vitest';
import {parseNestedBlockDeclarations} from '@codeindex/adapter-oracle/nestedBlocks';
import {createParserState, type OracleParserStateType} from '@codeindex/adapter-oracle/parserState';
import {TokenCursor} from '@codeindex/adapter-oracle/tokenCursor';
import {tokenizeOracleSource} from '@codeindex/adapter-oracle/tokenize';

const stateOf = (source: string): OracleParserStateType => {
	const tokenized = tokenizeOracleSource(source, 'nested.pkb');

	return createParserState(new TokenCursor(tokenized.tokens), 'APP', 'nested.pkb');
};

const parse = (state: OracleParserStateType): readonly string[] => {
	const members: string[] = [];

	parseNestedBlockDeclarations({
		state,
		start: 0,
		end: state.cursor.length - 1,
		parent: 0,
		unit: 0,
		parseMember: (cursor) => {
			members.push(state.cursor.text(cursor));
			return state.cursor.next(state.cursor.findDeclarationEnd(cursor));
		},
	});

	return members;
};

describe('Oracle nested block declaration parsing', () => {
	it('parses declarations in nested blocks, directives, and pragmas', () => {
		const state = stateOf(`DECLARE
	a NUMBER;
	$IF TRUE $THEN
	$END
	PRAGMA inline(a, 'x');
	BEGIN
		DECLARE
			b NUMBER;
		BEGIN
			NULL;
		END;
	END;
`);

		const members = parse(state);

		expect(members).toContain('a');
		expect(members).toContain('b');
	});

	it('skips empty statements and recovers when a declare block has no begin', () => {
		const state = stateOf('DECLARE ; END;\nDECLARE c NUMBER; BEGIN NULL; END;\n');

		expect(parse(state)).toStrictEqual(['c']);
	});

	it('returns without a member when the cursor starts beyond the token stream', () => {
		const state = stateOf('DECLARE a NUMBER; BEGIN NULL; END;\n');

		expect(() => {
			parseNestedBlockDeclarations({
				state,
				start: state.cursor.length + 5,
				end: state.cursor.length + 10,
				parent: 0,
				unit: 0,
				parseMember: () => state.cursor.length,
			});
		}).not.toThrow();
	});

	it('stops an inner declaration list at END without a begin', () => {
		const state = stateOf('DECLARE a NUMBER; END DECLARE b NUMBER; BEGIN NULL; END;\n');

		expect(parse(state)).toStrictEqual(['a', 'b']);
	});
});
