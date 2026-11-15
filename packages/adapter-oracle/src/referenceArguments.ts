import {namePartOf, oracleNameOf, type OracleNamePartType} from './name.ts';
import {type OracleParserStateType} from './parserState.ts';
import {type OracleNameReadType} from './tokenCursor.ts';
import {type OracleTypeReferenceType} from './syntax.ts';

const STATEMENT_PREVIOUS = new Set(['BEGIN', 'THEN', 'ELSE', 'LOOP', 'DECLARE', 'EXCEPTION', 'IS', 'AS', ';']);

export {argumentShapeOf} from './argumentExpressions.ts';

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

const STARRED_ITEM = new Set(['*']);

const selectIndexBefore = (state: OracleParserStateType, bulkIndex: number): number => {
	let depth = 0;

	for (let index = state.cursor.previous(bulkIndex); index >= 0; index = state.cursor.previous(index)) {
		const text = state.cursor.text(index);

		if (text === ')') {
			depth += 1;
		} else if (text === '(') {
			if (depth === 0) {
				return -1;
			}

			depth -= 1;
		} else if (depth === 0 && state.cursor.word(index, 'SELECT')) {
			return index;
		} else if (depth === 0 && (text === ';' || state.cursor.word(index, 'BULK') || state.cursor.word(index, 'RETURNING'))) {
			return -1;
		}
	}

	return -1;
};

const selectItemsOf = (state: OracleParserStateType, bulkIndex: number): readonly (readonly number[])[] | null => {
	const selectIndex = selectIndexBefore(state, bulkIndex);

	if (selectIndex < 0) {
		return null;
	}

	const items: number[][] = [];
	let tokens: number[] = [];
	let depth = 0;

	for (let index = state.cursor.next(selectIndex); index < bulkIndex; index = state.cursor.next(index)) {
		const text = state.cursor.text(index);

		if (text === '(') {
			depth += 1;
		} else if (text === ')') {
			depth = Math.max(0, depth - 1);
		}

		if (depth === 0 && text === ',') {
			items.push(tokens);
			tokens = [];
			continue;
		}

		tokens.push(index);
	}

	items.push(tokens);

	return items;
};

const itemCountOf = (state: OracleParserStateType, items: readonly (readonly number[])[]): number | null => {
	for (const item of items) {
		const texts = item.map((index) => (state.cursor.identifier(index) ? state.cursor.upper(index) : state.cursor.text(index)));

		if (texts.length === 1 && STARRED_ITEM.has(texts[0] ?? '')) {
			return null;
		}

		if (texts.length === 3 && state.cursor.text(item[1] ?? -1) === '.' && (texts[2] ?? '') === '*') {
			return null;
		}
	}

	return items.length;
};

const bulkTargetOf = (state: OracleParserStateType, start: number): Readonly<{parts: readonly OracleNamePartType[]; positionIndex: number}> | null => {
	const first = state.cursor.readQualifiedName(start);

	if (first === null) {
		return null;
	}

	const parts = [...first.parts];
	let cursor = first.nextIndex;
	let lastEnd = first.endIndex;
	let positionIndex = first.startIndex;

	for (;;) {
		if (state.cursor.text(cursor) !== '(') {
			break;
		}

		const close = state.cursor.findBalancedClose(cursor, state.cursor.findDeclarationEnd(cursor));

		if (close === null) {
			break;
		}

		positionIndex = lastEnd;

		const dot = state.cursor.next(close);
		const next = state.cursor.text(dot) === '.' ? state.cursor.readQualifiedName(state.cursor.next(dot)) : null;

		if (next === null) {
			break;
		}

		parts.push(...next.parts);
		lastEnd = next.endIndex;
		cursor = next.nextIndex;
	}

	return {parts, positionIndex};
};

/**
 * Adds the field-write marker PL/Scope records for a `BULK COLLECT INTO` target.
 *
 * Only the selected-item count is authoritative here; the target's element
 * record is resolved later. A `FETCH` has no authored select list, so its row
 * shape is unknown and no marker is added.
 *
 * @param state - Parser state.
 * @param bulkIndex - Token index of the `BULK` keyword.
 * @param unit - Unit declaration index.
 * @param enclosing - Enclosing declaration index.
 */
export const addBulkCollectSite = (state: OracleParserStateType, bulkIndex: number, unit: number, enclosing: number): void => {
	const intoIndex = state.cursor.next(state.cursor.next(bulkIndex));

	if (!state.cursor.word(intoIndex, 'INTO')) {
		return;
	}

	const target = bulkTargetOf(state, state.cursor.next(intoIndex));
	const items = target === null ? null : selectItemsOf(state, bulkIndex);

	if (target === null || items === null) {
		return;
	}

	state.references.push({
		name: oracleNameOf({parts: target.parts}),
		range: state.cursor.rawRange(target.positionIndex, target.positionIndex),
		nameRange: state.cursor.rawRange(target.positionIndex, target.positionIndex),
		unit,
		enclosing,
		kind: 'reference',
		argumentCount: null,
		argumentNames: [],
		rowType: false,
		usage: 4,
		bulkFields: itemCountOf(state, items),
	});
};
