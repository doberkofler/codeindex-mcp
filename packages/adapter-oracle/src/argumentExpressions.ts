import {oracleNameOf, type OracleNameType} from './name.ts';
import {type OracleParserStateType} from './parserState.ts';
import {type OracleTokenRangeType} from './tokenCursor.ts';
import {type OracleReferenceArgumentType} from './syntax.ts';

const INQUIRY_TEXT_WORDS = new Set(['$$PLSQL_UNIT', '$$PLSQL_SCOPE', '$$PLSQL_TYPE']);

type ArgumentShapeType = Readonly<{
	name: string | null;
	leadName: OracleNameType | undefined;
	indexed: boolean;
	literalType: string | undefined;
	argument: OracleReferenceArgumentType;
}>;

type ArgumentChainType = Readonly<{
	name: OracleNameType;
	indexed: boolean;
	invocation: readonly OracleReferenceArgumentType[];
}>;
type ShapeReaderType = (state: OracleParserStateType, range: OracleTokenRangeType) => ArgumentShapeType;

const isNumeric = (text: string): boolean => /^\d/u.test(text) || (text.startsWith('.') && /^\d/u.test(text.slice(1)));

const literalTypeOf = (state: OracleParserStateType, index: number): string | undefined => {
	const text = state.cursor.text(index);
	const word = state.cursor.upper(index);

	if (text.startsWith("'") || /^q'/iu.test(text)) {
		return 'VARCHAR2';
	}

	if (isNumeric(text)) {
		return 'NUMBER';
	}

	if (word === 'TRUE' || word === 'FALSE' || INQUIRY_TEXT_WORDS.has(word)) {
		return word === 'TRUE' || word === 'FALSE' ? 'BOOLEAN' : 'VARCHAR2';
	}

	if (word === '$$PLSQL_LINE') {
		return 'NUMBER';
	}

	return (word === 'DATE' || word === 'TIMESTAMP') && state.cursor.text(state.cursor.next(index)).startsWith("'") ? word : undefined;
};

const invocationOf = (state: OracleParserStateType, open: number, close: number, shapeOf: ShapeReaderType): readonly OracleReferenceArgumentType[] => {
	if (state.cursor.next(open) >= close) {
		return [];
	}

	return state.cursor.splitTopLevel(state.cursor.next(open), state.cursor.previous(close), ',').map((range) => shapeOf(state, range).argument);
};

const chainResult = (parts: OracleNameType['parts'], indexed: boolean, invocation: readonly OracleReferenceArgumentType[]): ArgumentChainType => ({
	name: oracleNameOf({parts}),
	indexed,
	invocation,
});

const readArgumentChain = (state: OracleParserStateType, start: number, shapeOf: ShapeReaderType): ArgumentChainType | undefined => {
	if (literalTypeOf(state, start) !== undefined) {
		return undefined;
	}

	const first = state.cursor.readQualifiedName(start);

	if (first === null) {
		return undefined;
	}

	const parts = [...first.parts];
	let cursor = first.nextIndex;

	for (;;) {
		if (state.cursor.text(cursor) !== '(') {
			return chainResult(parts, false, []);
		}

		const close = state.cursor.findBalancedClose(cursor, state.cursor.findDeclarationEnd(cursor));

		if (close === null) {
			return chainResult(parts, false, []);
		}

		const dot = state.cursor.next(close);
		const next = state.cursor.text(dot) === '.' ? state.cursor.readQualifiedName(state.cursor.next(dot)) : null;

		if (next === null) {
			return chainResult(parts, true, invocationOf(state, cursor, close, shapeOf));
		}

		parts.push(...next.parts);
		cursor = next.nextIndex;
	}
};

const argumentOf = (
	state: OracleParserStateType,
	range: OracleTokenRangeType,
	shape: Omit<ArgumentShapeType, 'argument'>,
	invocation: readonly OracleReferenceArgumentType[] | null,
): OracleReferenceArgumentType => ({
	range: state.cursor.rawRange(range.start, range.end),
	name: shape.name,
	...(shape.leadName === undefined ? {} : {leadName: shape.leadName}),
	...(shape.indexed ? {indexed: true} : {}),
	...(invocation === null || invocation.length === 0 ? {} : {invocation}),
	...(shape.literalType === undefined ? {} : {literalType: shape.literalType}),
});

/**
 * Reads the serializable value shape of one call argument.
 *
 * @param state - Parser state.
 * @param range - Authored argument range.
 * @returns Parameter association and static expression evidence.
 */
export const argumentShapeOf = (state: OracleParserStateType, range: OracleTokenRangeType): ArgumentShapeType => {
	const first = state.cursor.readQualifiedName(range.start);

	if (first === null) {
		const shape = {name: null, leadName: undefined, indexed: false, literalType: literalTypeOf(state, range.start)};
		return {...shape, argument: argumentOf(state, range, shape, null)};
	}

	const association = state.cursor.text(first.nextIndex);
	const named = association === '=>' || (association === '=' && state.cursor.text(state.cursor.next(first.nextIndex)) === '>');
	const valueStart = named ? state.cursor.next(state.cursor.next(first.nextIndex)) : range.start;
	const value = readArgumentChain(state, valueStart, argumentShapeOf);
	const shape = {
		name: named ? (first.parts.at(-1)?.canonical ?? null) : null,
		leadName: value?.name,
		indexed: value?.indexed ?? false,
		literalType: value === undefined ? literalTypeOf(state, valueStart) : undefined,
	};

	return {...shape, argument: argumentOf(state, range, shape, value?.invocation ?? null)};
};
