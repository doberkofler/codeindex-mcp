import {ORACLE_DIAGNOSTIC} from './diagnostics.ts';
import {namePartOf, splitObjectName} from './name.ts';
import {rangeOf, recoverTopLevel, warnAt, type OracleParserStateType} from './parserState.ts';
import {type OracleUnitKindType} from './syntax.ts';
import {type TokenCursor} from './tokenCursor.ts';

const TABLE_PREFIXES = new Set(['GLOBAL', 'PRIVATE', 'TEMPORARY', 'SHARDED', 'DUPLICATED', 'IMMUTABLE', 'BLOCKCHAIN']);
const TABLE_CONSTRAINT_PREFIXES = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'SUPPLEMENTAL', 'PERIOD']);

/**
 * Locates the unit keyword after supported CREATE modifiers.
 *
 * @param state - Structural parser state.
 * @param index - Candidate CREATE token.
 * @returns Unit keyword token index.
 */
export const oracleDeclarationKeyword = (state: OracleParserStateType, index: number): number => {
	if (!state.cursor.word(index, 'CREATE')) {
		return index;
	}

	let cursor = state.cursor.next(index);

	if (state.cursor.word(cursor, 'OR') && state.cursor.word(state.cursor.next(cursor), 'REPLACE')) {
		cursor = state.cursor.next(state.cursor.next(cursor));
	}

	while (
		state.cursor.word(cursor, 'EDITIONABLE') ||
		state.cursor.word(cursor, 'NONEDITIONABLE') ||
		state.cursor.word(cursor, 'FORCE') ||
		(state.cursor.word(cursor, 'NO') && state.cursor.word(state.cursor.next(cursor), 'FORCE')) ||
		TABLE_PREFIXES.has(state.cursor.upper(cursor))
	) {
		cursor = state.cursor.next(cursor);
	}

	return cursor;
};

/**
 * Returns the supported top-level unit kind at one token.
 *
 * @param state - Structural parser state.
 * @param index - Unit keyword token index.
 * @returns Supported unit kind, or null.
 */
export const oracleUnitKindAt = (state: OracleParserStateType, index: number): OracleUnitKindType | null => {
	if (state.cursor.word(index, 'PACKAGE')) {
		return state.cursor.word(state.cursor.next(index), 'BODY') ? 'package-body' : 'package-spec';
	}

	if (state.cursor.word(index, 'PROCEDURE')) {
		return 'procedure';
	}
	if (state.cursor.word(index, 'FUNCTION')) {
		return 'function';
	}
	if (state.cursor.word(index, 'TABLE')) {
		return 'table';
	}
	if (state.cursor.word(index, 'VIEW')) {
		return 'view';
	}

	return null;
};

const addSqlUnit = (
	input: Readonly<{
		state: OracleParserStateType;
		unitStart: number;
		end: number;
		name: NonNullable<ReturnType<TokenCursor['readQualifiedName']>>;
		kind: 'table' | 'view';
	}>,
): number => {
	const {state} = input;
	const parsedName = splitObjectName(input.name, state.defaultSchema);
	const unitIndex = state.units.length;
	const declarationIndex = state.declarations.length;
	const range = rangeOf(state, input.unitStart, input.end);
	const nameRange = rangeOf(state, input.name.endIndex, input.name.endIndex);

	state.declarations.push({
		kind: input.kind,
		name: parsedName.object,
		range,
		nameRange,
		parent: null,
		unit: unitIndex,
		exported: true,
		parameters: [],
		typeReferences: [],
	});
	state.definitionStarts.add(nameRange.startOffset);
	state.units.push({
		kind: input.kind,
		schema: parsedName.schema,
		name: parsedName.object,
		canonical: `${parsedName.schema.canonical}.${parsedName.object.canonical}`,
		range,
		nameRange,
		declaration: declarationIndex,
	});

	return declarationIndex;
};

const parseTableColumn = (input: Readonly<{state: OracleParserStateType; start: number; end: number; parent: number; unit: number}>): void => {
	const {state} = input;

	if (!state.cursor.identifier(input.start) || TABLE_CONSTRAINT_PREFIXES.has(state.cursor.upper(input.start))) {
		return;
	}

	const nameRange = rangeOf(state, input.start, input.start);
	state.declarations.push({
		kind: 'column',
		name: namePartOf(state.cursor.text(input.start)),
		range: rangeOf(state, input.start, input.end),
		nameRange,
		parent: input.parent,
		unit: input.unit,
		exported: true,
		parameters: [],
		typeReferences: [],
	});
	state.definitionStarts.add(nameRange.startOffset);
};

const parseTable = (state: OracleParserStateType, unitStart: number, tableIndex: number): number => {
	const name = state.cursor.readQualifiedName(state.cursor.next(tableIndex));

	if (name === null) {
		warnAt(state, ORACLE_DIAGNOSTIC.parse, 'Unable to read table name', tableIndex);
		return recoverTopLevel(state, tableIndex);
	}

	const end = state.cursor.findDeclarationEnd(unitStart);
	const declarationIndex = addSqlUnit({state, unitStart, end, name, kind: 'table'});
	const unitIndex = state.units.length - 1;
	const open = state.cursor.text(name.nextIndex) === '(' ? name.nextIndex : null;
	const close = open === null ? null : state.cursor.findBalancedClose(open, end);

	if (open !== null && close !== null) {
		for (const column of state.cursor.splitTopLevel(state.cursor.next(open), state.cursor.previous(close), ',')) {
			parseTableColumn({state, start: column.start, end: column.end, parent: declarationIndex, unit: unitIndex});
		}
	}

	return state.cursor.next(end);
};

const parseView = (state: OracleParserStateType, unitStart: number, viewIndex: number): number => {
	const name = state.cursor.readQualifiedName(state.cursor.next(viewIndex));

	if (name === null) {
		warnAt(state, ORACLE_DIAGNOSTIC.parse, 'Unable to read view name', viewIndex);
		return recoverTopLevel(state, viewIndex);
	}

	const end = state.cursor.findDeclarationEnd(unitStart);
	addSqlUnit({state, unitStart, end, name, kind: 'view'});
	return state.cursor.next(end);
};

/**
 * Parses one supported SQL DDL declaration.
 *
 * @param state - Structural parser state.
 * @param unitStart - CREATE token index.
 * @param keyword - TABLE or VIEW token index.
 * @param kind - SQL declaration kind.
 * @returns Token after the declaration.
 */
export const parseOracleDdlDeclaration = (state: OracleParserStateType, unitStart: number, keyword: number, kind: 'table' | 'view'): number =>
	kind === 'table' ? parseTable(state, unitStart, keyword) : parseView(state, unitStart, keyword);
