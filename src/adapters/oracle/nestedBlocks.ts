import {type OracleParserStateType} from './parserState.ts';

type ParseMemberType = (cursor: number, parent: number, unit: number, exported: boolean) => number;

/**
 * Parses declarations inside nested `DECLARE` blocks in a routine body.
 *
 * Nested block locals are visible to the containing routine, so they are
 * attached to that routine. Their declarations are indexed for reference
 * resolution but remain non-exported. Shadowing follows source order through
 * the nearest-declaration rule in the resolver.
 *
 * @param input - Parser state, block extent, owner, and member parser.
 */
export const parseNestedBlockDeclarations = (
	input: Readonly<{
		state: OracleParserStateType;
		start: number;
		end: number;
		parent: number;
		unit: number;
		parseMember: ParseMemberType;
	}>,
): void => {
	let cursor = input.start;

	while (cursor <= input.end && cursor < input.state.cursor.length) {
		if (!input.state.cursor.word(cursor, 'DECLARE')) {
			cursor = input.state.cursor.next(cursor);
			continue;
		}

		cursor = input.state.cursor.next(cursor);

		while (cursor <= input.end && cursor < input.state.cursor.length && !input.state.cursor.word(cursor, 'BEGIN')) {
			if (input.state.cursor.text(cursor) === ';') {
				cursor = input.state.cursor.next(cursor);
				continue;
			}

			if (input.state.cursor.word(cursor, 'END')) {
				break;
			}

			if (input.state.cursor.text(cursor).startsWith('$')) {
				cursor = input.state.cursor.next(input.state.cursor.findDirectiveEnd(cursor));
				continue;
			}

			cursor = input.state.cursor.word(cursor, 'PRAGMA')
				? input.state.cursor.next(input.state.cursor.findDeclarationEnd(cursor))
				: input.parseMember(cursor, input.parent, input.unit, false);
		}

		if (!input.state.cursor.word(cursor, 'BEGIN')) {
			continue;
		}

		const block = input.state.cursor.findBlockEnd(cursor);

		parseNestedBlockDeclarations({...input, start: input.state.cursor.next(cursor), end: block.endIndex});
		cursor = input.state.cursor.next(block.endIndex);
	}
};
