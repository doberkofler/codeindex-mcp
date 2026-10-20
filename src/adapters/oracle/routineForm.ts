import {type OracleParserStateType} from './parserState.ts';
import {type OracleDeclarationFormType, type OracleUnitKindType} from './syntax.ts';

type SignatureType = Readonly<{index: number; nextIndex: number; start: number; hasBody: boolean}>;

const polymorphicTableFunction = (state: OracleParserStateType, keyword: number, declarationEnd: number): boolean => {
	for (let index = keyword; index < declarationEnd; index = state.cursor.next(index)) {
		if (state.cursor.word(index, 'POLYMORPHIC')) {
			return true;
		}

		if (!state.cursor.word(index, 'PRAGMA') || !state.cursor.word(state.cursor.next(index), 'INTERFACE')) {
			continue;
		}

		const open = state.cursor.next(state.cursor.next(index));

		if (state.cursor.text(open) === '(' && state.cursor.word(state.cursor.next(open), 'PTF')) {
			return true;
		}
	}

	return false;
};

/**
 * Records the source form of one routine declaration.
 *
 * @param state - Parser state with visible tokens.
 * @param input - Routine keyword, parsed signature, and owning unit kind.
 * @returns The exact declaration form used for pairing and ranking.
 */
export const routineFormOf = (
	state: OracleParserStateType,
	input: Readonly<{keyword: number; signature: SignatureType; unitKind: OracleUnitKindType | null}>,
): OracleDeclarationFormType => {
	if (input.signature.hasBody) {
		const firstClause = state.cursor.upper(input.signature.nextIndex);

		return firstClause === 'LANGUAGE' || firstClause === 'EXTERNAL' ? 'call_spec' : 'full_definition';
	}

	const declarationEnd = state.cursor.findDeclarationEnd(input.keyword);

	if (polymorphicTableFunction(state, input.keyword, declarationEnd)) {
		return 'polymorphic_table_function';
	}

	return input.unitKind === 'package-body' ? 'body_forward' : 'specification';
};
