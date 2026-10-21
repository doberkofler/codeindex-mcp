import {namePartOf} from './name.ts';
import {type OracleNameReadType} from './tokenCursor.ts';
import {type OracleDeclarationType, type OracleReferenceSiteType} from './syntax.ts';
import {type OracleParserStateType} from './parserState.ts';

/**
 * Returns the token after a PRAGMA argument statement.
 *
 * @param state - Parser state.
 * @param index - Current token index.
 * @returns Next token after the pragma, or null outside a pragma.
 */
export const pragmaArgumentEnd = (state: OracleParserStateType, index: number): number | null =>
	state.cursor.word(state.cursor.previous(index), 'PRAGMA') ? state.cursor.next(state.cursor.findDeclarationEnd(index)) : null;

/**
 * Returns whether a token starts a SQL statement.
 *
 * @param state - Parser state.
 * @param index - Current token index.
 * @returns Whether this token opens a SQL statement.
 */
export const isSqlStart = (state: OracleParserStateType, index: number): boolean =>
	state.cursor.word(index, 'SELECT') ||
	state.cursor.word(index, 'INSERT') ||
	state.cursor.word(index, 'UPDATE') ||
	state.cursor.word(index, 'DELETE') ||
	state.cursor.word(index, 'MERGE');

/**
 * Returns whether a token ends a SQL statement or FOR header.
 *
 * @param state - Parser state.
 * @param index - Current token index.
 * @returns Whether this token closes SQL or a FOR header.
 */
export const isSqlEnd = (state: OracleParserStateType, index: number): boolean => state.cursor.text(index) === ';' || state.cursor.word(index, 'LOOP');

/**
 * Returns whether a token closes an INTO target list.
 *
 * @param state - Parser state.
 * @param index - Current token index.
 * @returns Whether the target list ends before this token.
 */
const endsIntoTarget = (state: OracleParserStateType, index: number): boolean =>
	state.cursor.word(index, 'FROM') || state.cursor.word(index, 'VALUES') || isSqlEnd(state, index);

/**
 * Advances the SELECT-INTO target-list state.
 *
 * @param input - Parser state, current token, and whether an INTO list is open.
 * @returns Updated state and whether the current token was consumed.
 */
export const nextIntoState = (
	input: Readonly<{state: OracleParserStateType; index: number; intoTarget: boolean}>,
): Readonly<{intoTarget: boolean; consumed: boolean}> => {
	if (input.state.cursor.word(input.index, 'INTO')) {
		return {intoTarget: true, consumed: true};
	}

	return {
		intoTarget: input.intoTarget && !endsIntoTarget(input.state, input.index),
		consumed: false,
	};
};

const TYPE_SIZE_WORDS = new Set([
	'VARCHAR2',
	'VARCHAR',
	'NVARCHAR2',
	'CHAR',
	'NCHAR',
	'NUMBER',
	'DECIMAL',
	'NUMERIC',
	'RAW',
	'VARRAY',
	'BINARY_FLOAT',
	'BINARY_DOUBLE',
]);

/**
 * Returns whether a token is a datatype length or size argument.
 *
 * @param state - Parser state.
 * @param index - Current token index.
 * @returns Whether the identifier is inside a type size expression.
 */
export const isTypeSizeArgument = (state: OracleParserStateType, index: number): boolean => {
	const open = state.cursor.previous(index);

	return state.cursor.text(open) === '(' && TYPE_SIZE_WORDS.has(state.cursor.upper(state.cursor.previous(open)));
};

const isSavepointName = (state: OracleParserStateType, index: number): boolean => {
	const previous = state.cursor.previous(index);

	return state.cursor.word(previous, 'SAVEPOINT') || (state.cursor.word(previous, 'TO') && state.cursor.word(state.cursor.previous(previous), 'ROLLBACK'));
};

/**
 * Returns whether the scanner must ignore this token as a reference.
 *
 * @param state - Parser state.
 * @param index - Current token index.
 * @returns Whether the token is not an identifier or names a savepoint.
 */
export const isIgnoredIdentifier = (state: OracleParserStateType, index: number): boolean => !state.cursor.identifier(index) || isSavepointName(state, index);

export const addLoopIterator = (state: OracleParserStateType, index: number, names: Set<string>): void => {
	if (!state.cursor.word(index, 'FOR')) {
		return;
	}

	const iterator = state.cursor.next(index);

	if (state.cursor.identifier(iterator) && !state.cursor.word(iterator, 'UPDATE')) {
		names.add(namePartOf(state.cursor.text(iterator)).canonical);
	}
};

export const nextForHeader = (state: OracleParserStateType, index: number, current: boolean): boolean =>
	state.cursor.word(index, 'FOR') || (current && !state.cursor.word(index, 'LOOP') && state.cursor.text(index) !== ';');

export const isDeclarationName = (state: OracleParserStateType, index: number, name: OracleNameReadType): boolean =>
	state.definitionStarts.has(state.cursor.token(index)?.startOffset ?? -1) || state.definitionStarts.has(state.cursor.token(name.endIndex)?.startOffset ?? -1);

export const isNamedAssociation = (state: OracleParserStateType, after: number): boolean =>
	state.cursor.text(after) === '=>' || (state.cursor.text(after) === '=' && state.cursor.text(state.cursor.next(after)) === '>');

/**
 * Returns whether a resolved site must not become an occurrence.
 *
 * @param site - Authored reference site.
 * @param target - Resolved declaration.
 * @returns Whether the site is a non-reference syntactic context.
 */
const isRoutine = (target: OracleDeclarationType | undefined): boolean => target?.kind === 'procedure' || target?.kind === 'function';

const isBareSqlIdentifier = (site: OracleReferenceSiteType): boolean => site.sql === true && site.kind === 'reference' && site.name.parts.length === 1;

export const suppressNonRoutine = (site: OracleReferenceSiteType, target: OracleDeclarationType | undefined): boolean => {
	// A bare identifier in SQL is a column name even when a routine of the same
	// name is in scope. A qualified name can only be a package routine call.
	if (isBareSqlIdentifier(site) && isRoutine(target)) {
		return true;
	}

	if (site.forRange === true && target?.kind === 'constant') {
		return true;
	}

	if (site.typeSize === true && target?.kind === 'constant') {
		return true;
	}

	return site.iteratorBase === true && target?.kind === 'field';
};
