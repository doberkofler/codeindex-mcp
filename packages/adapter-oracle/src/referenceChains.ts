import {namePartOf, type OracleNamePartType} from './name.ts';
import {type OracleNameReadType} from './tokenCursor.ts';
import {type OracleParserStateType} from './parserState.ts';

/**
 * Reads the token indexes of top-level identifiers in one authored name.
 *
 * Identifiers inside call/index parentheses are excluded so that
 * `collection(i).field` keeps `collection` and `field` as the only parts.
 *
 * @param state - Parser state.
 * @param name - Authored name with its token extent.
 * @returns Token indexes in source order.
 */
const topLevelPartTokens = (state: OracleParserStateType, name: OracleNameReadType): readonly number[] => {
	const tokens: number[] = [];
	let depth = 0;

	for (let cursor = name.startIndex; cursor <= name.endIndex; cursor = state.cursor.next(cursor)) {
		const text = state.cursor.text(cursor);

		if (text === '(') {
			depth += 1;
		} else if (text === ')') {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0 && state.cursor.identifier(cursor)) {
			tokens.push(cursor);
		}
	}

	return tokens;
};

const matchingOpen = (state: OracleParserStateType, close: number): number | null => {
	let depth = 0;

	for (let cursor = close; cursor >= 0; cursor = state.cursor.previous(cursor)) {
		const text = state.cursor.text(cursor);

		if (text === ')') {
			depth += 1;
		} else if (text === '(') {
			depth -= 1;

			if (depth === 0) {
				return cursor;
			}
		}
	}

	return null;
};

/**
 * Reconstructs the member chain that precedes one identifier.
 *
 * `collection(i).field` and `record.child.field` both contribute their
 * value-level parts; the indexed expression itself is not a name part.
 *
 * @param state - Parser state.
 * @param index - Identifier token index.
 * @returns Parts through this identifier and the base token index, or null.
 */
const chainPartsAt = (state: OracleParserStateType, index: number): Readonly<{parts: readonly OracleNamePartType[]; startIndex: number}> | null => {
	const dot = state.cursor.previous(index);

	if (state.cursor.text(dot) !== '.') {
		return null;
	}

	let before = state.cursor.previous(dot);
	let base: Readonly<{parts: readonly OracleNamePartType[]; startIndex: number}> | null = null;

	// Walk back over any run of index groups so that `table(key)(row).field` and
	// `collection(i).field` share the same chain reconstruction.
	for (;;) {
		if (state.cursor.identifier(before)) {
			base = chainPartsAt(state, before) ?? {parts: [namePartOf(state.cursor.text(before))], startIndex: before};
			break;
		}

		if (state.cursor.text(before) !== ')') {
			break;
		}

		const open = matchingOpen(state, before);

		if (open === null) {
			break;
		}

		before = state.cursor.previous(open);
	}

	return base === null ? null : {parts: [...base.parts, namePartOf(state.cursor.text(index))], startIndex: base.startIndex};
};

/**
 * Prepends the member chain that precedes one authored name.
 *
 * @param state - Parser state.
 * @param name - Authored name read from the current identifier.
 * @param index - Current identifier token index.
 * @returns Name with its reconstructed chain prefix.
 */
export const nameWithChain = (state: OracleParserStateType, name: OracleNameReadType, index: number): OracleNameReadType => {
	const chain = chainPartsAt(state, index);

	if (chain === null || chain.parts.length < 2) {
		return name;
	}

	return {...name, parts: [...chain.parts.slice(0, -1), ...name.parts], startIndex: chain.startIndex};
};

export const addChainPrefixes = (
	input: Readonly<{
		state: OracleParserStateType;
		name: OracleNameReadType;
		unit: number;
		enclosing: number;
		sql?: boolean | undefined;
		forBound?: boolean | undefined;
		forRange?: boolean | undefined;
		typeSize?: boolean | undefined;
		iteratorBase?: boolean | undefined;
		emit: (
			state: OracleParserStateType,
			site: Readonly<{
				name: OracleNameReadType;
				start: number;
				end: number;
				unit: number;
				enclosing: number;
				kind: 'call' | 'reference';
				argumentCount: null;
				argumentNames: readonly string[];
				rowType: false;
				sql?: boolean | undefined;
				forBound?: boolean | undefined;
				forRange?: boolean | undefined;
				typeSize?: boolean | undefined;
				iteratorBase?: boolean | undefined;
				usage: number;
			}>,
		) => void;
	}>,
): void => {
	const partTokens = topLevelPartTokens(input.state, input.name);

	for (let part = 0; part < input.name.parts.length - 1; part += 1) {
		const partToken = partTokens[part];

		if (partToken === undefined) {
			continue;
		}

		input.emit(input.state, {
			name: {
				parts: input.name.parts.slice(0, part + 1),
				startIndex: input.name.startIndex,
				endIndex: partToken,
				nextIndex: input.state.cursor.next(partToken),
			},
			start: input.name.startIndex,
			end: partToken,
			unit: input.unit,
			enclosing: input.enclosing,
			kind: input.state.cursor.text(input.state.cursor.next(partToken)) === '(' ? 'call' : 'reference',
			argumentCount: null,
			argumentNames: [],
			rowType: false,
			sql: input.sql,
			forBound: input.forBound,
			forRange: input.forRange,
			typeSize: input.typeSize,
			iteratorBase: input.iteratorBase,
			usage: 2,
		});
	}
};
