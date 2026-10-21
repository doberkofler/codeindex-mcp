import {namePartOf, oracleNameOf, type OracleNamePartType, type OracleNameType} from './name.ts';
import {type OracleParserStateType} from './parserState.ts';
import {type OracleNameReadType, type OracleTokenRangeType} from './tokenCursor.ts';
import {type OracleTypeReferenceType} from './syntax.ts';

const INQUIRY_TEXT_WORDS = new Set(['$$PLSQL_UNIT', '$$PLSQL_SCOPE', '$$PLSQL_TYPE']);
const STATEMENT_PREVIOUS = new Set(['BEGIN', 'THEN', 'ELSE', 'LOOP', 'DECLARE', 'EXCEPTION', 'IS', 'AS', ';']);

const isNumeric = (text: string): boolean => /^\d/u.test(text) || (text.startsWith('.') && /^\d/u.test(text.slice(1)));

/**
 * Returns the built-in type a literal or inquiry directive implies.
 *
 * @param state - Parser state.
 * @param index - Token index of the argument value.
 * @returns The canonical built-in type, or undefined when the value is not a literal.
 */
const literalTypeOf = (state: OracleParserStateType, index: number): string | undefined => {
	const text = state.cursor.text(index);
	const word = state.cursor.upper(index);

	if (text.startsWith("'") || /^q'/iu.test(text)) {
		return 'VARCHAR2';
	}

	if (isNumeric(text)) {
		return 'NUMBER';
	}

	if (word === 'TRUE' || word === 'FALSE') {
		return 'BOOLEAN';
	}

	if (INQUIRY_TEXT_WORDS.has(word)) {
		return 'VARCHAR2';
	}

	if (word === '$$PLSQL_LINE') {
		return 'NUMBER';
	}

	return (word === 'DATE' || word === 'TIMESTAMP') && state.cursor.text(state.cursor.next(index)).startsWith("'") ? word : undefined;
};

/**
 * Reads the value chain of an argument, ignoring indexed expressions.
 *
 * `record.collection(i).field` contributes `record.collection.field`, so the
 * argument's static type is the type of the final member rather than the type
 * of the indexed collection.
 *
 * @param state - Parser state.
 * @param start - Index of the first token of the argument value.
 * @returns The value name and whether it ends with an index expression.
 */
const readArgumentChain = (state: OracleParserStateType, start: number): Readonly<{name: OracleNameType; indexed: boolean}> | undefined => {
	if (literalTypeOf(state, start) !== undefined) {
		return undefined;
	}

	const first = state.cursor.readQualifiedName(start);

	if (first === null) {
		return undefined;
	}

	const parts = [...first.parts];
	let cursor = first.nextIndex;
	let indexed = false;

	for (;;) {
		if (state.cursor.text(cursor) !== '(') {
			return {name: oracleNameOf({parts}), indexed};
		}

		const close = state.cursor.findBalancedClose(cursor, state.cursor.findDeclarationEnd(cursor));

		if (close === null) {
			return {name: oracleNameOf({parts}), indexed};
		}

		const dot = state.cursor.next(close);
		const next = state.cursor.text(dot) === '.' ? state.cursor.readQualifiedName(state.cursor.next(dot)) : null;

		if (next === null) {
			return {name: oracleNameOf({parts}), indexed: true};
		}

		parts.push(...next.parts);
		cursor = next.nextIndex;
		indexed = false;
	}
};

/**
 * Reads the value shape of one call argument.
 *
 * Named associations are described by their value, not by the parameter name.
 * The shape lets overload resolution reject candidates whose parameter type
 * cannot accept a literal or a statically typed name.
 *
 * @param state - Parser state.
 * @param range - Authored argument range.
 * @returns Parameter name, value name, index shape, and literal type.
 */
export const argumentShapeOf = (
	state: OracleParserStateType,
	range: OracleTokenRangeType,
): Readonly<{name: string | null; leadName: OracleNameType | undefined; indexed: boolean; literalType: string | undefined}> => {
	const first = state.cursor.readQualifiedName(range.start);

	if (first === null) {
		return {name: null, leadName: undefined, indexed: false, literalType: literalTypeOf(state, range.start)};
	}

	const association = state.cursor.text(first.nextIndex);
	const named = association === '=>' || (association === '=' && state.cursor.text(state.cursor.next(first.nextIndex)) === '>');
	const valueStart = named ? state.cursor.next(state.cursor.next(first.nextIndex)) : range.start;
	const value = readArgumentChain(state, valueStart);

	return {
		name: named ? (first.parts.at(-1)?.canonical ?? null) : null,
		leadName: value?.name,
		indexed: value?.indexed ?? false,
		literalType: value === undefined ? literalTypeOf(state, valueStart) : undefined,
	};
};

/**
 * Returns whether a name begins a PL/SQL statement.
 *
 * A statement-position call must invoke a procedure; an expression-position
 * call must invoke a function. That distinction separates overloads whose
 * parameter shapes are otherwise identical.
 *
 * @param state - Parser state.
 * @param start - Token index of the authored name.
 * @returns Whether the previous token opens a statement.
 */
export const statementStart = (state: OracleParserStateType, start: number): boolean => {
	const previous = state.cursor.previous(start);

	return previous < 0 || STATEMENT_PREVIOUS.has(state.cursor.text(previous)) || STATEMENT_PREVIOUS.has(state.cursor.upper(previous));
};

/**
 * Returns whether an assignment operator follows one or more balanced index
 * groups that start at `open`.
 *
 * @param state - Parser state.
 * @param open - Index of the first `(`.
 * @returns Whether `:=` follows the last index group.
 */
export const assignFollows = (state: OracleParserStateType, open: number): boolean => {
	let cursor = open;

	for (;;) {
		if (state.cursor.text(cursor) !== '(') {
			return false;
		}

		const close = state.cursor.findBalancedClose(cursor, state.cursor.findDeclarationEnd(cursor));

		if (close === null) {
			return false;
		}

		const after = state.cursor.next(close);

		if (state.cursor.text(after) === ':=') {
			return true;
		}

		cursor = after;
	}
};

/**
 * Returns whether a FOR header bounds an integer range rather than a cursor.
 *
 * @param state - Parser state.
 * @param forIndex - Token index of the `FOR` keyword.
 * @returns Whether a range operator appears before the loop body.
 */
export const forRangeAt = (state: OracleParserStateType, forIndex: number): boolean => {
	let depth = 0;

	for (let index = state.cursor.next(forIndex); index < state.cursor.length; index = state.cursor.next(index)) {
		const text = state.cursor.text(index);

		if (text === '(') {
			depth += 1;
		} else if (text === ')') {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0 && (state.cursor.word(index, 'LOOP') || text === ';')) {
			return false;
		} else if (text === '..') {
			return true;
		}
	}

	return false;
};

const TYPE_ANCHOR_KEYWORDS = new Set(['%TYPE', '%ROWTYPE']);

const TYPE_SHAPE_KEYWORDS = new Set([
	'IS',
	'AS',
	'TABLE',
	'VARRAY',
	'OF',
	'REF',
	'CURSOR',
	'RECORD',
	'INDEX',
	'BY',
	'RETURN',
	'CONSTANT',
	'DEFAULT',
	'NOT',
	'NULL',
	'IN',
	'OUT',
	'NOCOPY',
]);

const nameBefore = (state: OracleParserStateType, endIndex: number): OracleNameReadType | null => {
	if (!state.cursor.identifier(endIndex)) {
		return null;
	}

	const parts: OracleNamePartType[] = [namePartOf(state.cursor.text(endIndex))];
	let startIndex = endIndex;
	let cursor = endIndex;

	for (;;) {
		const dot = state.cursor.previous(cursor);

		if (state.cursor.text(dot) !== '.') {
			break;
		}

		const component = state.cursor.previous(dot);

		if (!state.cursor.identifier(component)) {
			break;
		}

		parts.unshift(namePartOf(state.cursor.text(component)));
		startIndex = component;
		cursor = component;
	}

	return {parts, startIndex, endIndex, nextIndex: state.cursor.next(endIndex)};
};

/**
 * Extracts the symbolic type a declaration is written with.
 *
 * A `%TYPE` or `%ROWTYPE` anchor marks the reference as unresolved because the
 * anchored type is not part of the corpus.
 *
 * @param state - Parser state.
 * @param start - First token of the type specification.
 * @param end - Last token of the type specification.
 * @returns At most one symbolic type reference.
 */
export const typeReferencesOf = (state: OracleParserStateType, start: number, end: number): readonly OracleTypeReferenceType[] => {
	let declaredName: OracleNameReadType | null = null;

	for (let index = Math.max(0, start); index <= end; index = state.cursor.next(index)) {
		if (!TYPE_ANCHOR_KEYWORDS.has(state.cursor.upper(index))) {
			if (
				declaredName === null &&
				state.cursor.identifier(index) &&
				!TYPE_SHAPE_KEYWORDS.has(state.cursor.upper(index)) &&
				state.cursor.text(state.cursor.previous(index)) !== '.'
			) {
				declaredName = state.cursor.readQualifiedName(index);
			}

			continue;
		}

		const name = nameBefore(state, state.cursor.previous(index));

		if (name !== null) {
			return [
				{
					name: oracleNameOf({parts: name.parts}),
					range: state.cursor.rawRange(name.startIndex, index),
					rowType: state.cursor.upper(index) === '%ROWTYPE',
					anchored: state.cursor.upper(index) === '%TYPE',
				},
			];
		}
	}

	return declaredName === null
		? []
		: [
				{
					name: oracleNameOf({parts: declaredName.parts}),
					range: state.cursor.rawRange(declaredName.startIndex, declaredName.endIndex),
					rowType: false,
					anchored: false,
				},
			];
};
