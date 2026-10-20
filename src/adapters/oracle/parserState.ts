import {OracleDiagnosticCollector, type OracleDiagnosticCodeType} from './diagnostics.ts';
import {namePartOf, oracleNameOf, type OracleNamePartType, type OracleNameType} from './name.ts';
import {addChainPrefixes, nameWithChain} from './referenceChains.ts';
import {
	addLoopIterator,
	isDeclarationName,
	isIgnoredIdentifier,
	isNamedAssociation,
	isSqlEnd,
	isSqlStart,
	isTypeSizeArgument,
	nextForHeader,
	nextIntoState,
	pragmaArgumentEnd,
} from './referenceScan.ts';
import {type OracleNameReadType, type TokenCursor} from './tokenCursor.ts';
import {
	type OracleDeclarationType,
	type OracleDependencySiteType,
	type OracleRangeType,
	type OracleReferenceArgumentType,
	type OracleReferenceSiteType,
	type OracleTypeReferenceType,
	type OracleUnitType,
} from './syntax.ts';

const TYPE_ANCHORS = new Set(['%TYPE', '%ROWTYPE']);

export type OracleParserStateType = {
	cursor: TokenCursor;
	defaultSchema: string;
	units: OracleUnitType[];
	declarations: OracleDeclarationType[];
	references: OracleReferenceSiteType[];
	dependencies: OracleDependencySiteType[];
	diagnostics: OracleDiagnosticCollector;
	definitionStarts: Set<number>;
};

export const createParserState = (cursor: TokenCursor, defaultSchema: string, path: string): OracleParserStateType => ({
	cursor,
	defaultSchema,
	units: [],
	declarations: [],
	references: [],
	dependencies: [],
	diagnostics: new OracleDiagnosticCollector(path),
	definitionStarts: new Set(),
});

export const rangeOf = (state: OracleParserStateType, start: number, end: number): OracleRangeType => state.cursor.rawRange(start, end);

export const addDeclaration = (state: OracleParserStateType, declaration: OracleDeclarationType): number => {
	state.declarations.push(declaration);
	state.definitionStarts.add(declaration.nameRange.startOffset);
	return state.declarations.length - 1;
};

export const warnAt = (state: OracleParserStateType, code: OracleDiagnosticCodeType, message: string, index: number): void => {
	const token = state.cursor.token(index);
	state.diagnostics.add(code, message, token?.startLine ?? null, token?.startColumn ?? null);
};

export const statementEnd = (nextIndex: number): number => Math.max(0, nextIndex - 1);

export const recoverMember = (state: OracleParserStateType, start: number): number => {
	const end = state.cursor.findDeclarationEnd(start);
	return state.cursor.next(end);
};

export const recoverTopLevel = (state: OracleParserStateType, start: number): number => {
	for (let index = Math.max(0, start); index < state.cursor.length; index = state.cursor.next(index)) {
		if (state.cursor.isSlashBoundary(index)) {
			return state.cursor.next(index);
		}

		if (state.cursor.word(index, 'CREATE') && index > start) {
			return index;
		}
	}

	return state.cursor.length;
};
const normalizedPart = (state: OracleParserStateType, index: number): string => {
	const text = state.cursor.text(index);

	return state.cursor.identifier(index) ? namePartOf(text).canonical : text;
};

const startsParameterDefault = (state: OracleParserStateType, index: number, depth: number): boolean =>
	depth === 1 && (state.cursor.word(index, 'DEFAULT') || state.cursor.text(index) === ':=');

const isOmittedInputMode = (state: OracleParserStateType, index: number, depth: number): boolean =>
	depth === 1 && state.cursor.word(index, 'IN') && !state.cursor.word(state.cursor.next(index), 'OUT');

export const normalizedTokens = (state: OracleParserStateType, start: number, end: number): string => {
	const parts: string[] = [];

	for (let index = Math.max(0, start); index <= end; index = state.cursor.next(index)) {
		parts.push(normalizedPart(state, index));
	}

	return parts.join('').toUpperCase();
};

/**
 * Normalizes one routine or cursor heading for spec/body pairing.
 *
 * Parameter defaults are legal only on one side of a spec/body pair, so the
 * `DEFAULT` or `:=` clause and its expression are omitted. A lone `IN` mode is
 * also omitted, because it is the default mode. Parameter names, `OUT` and
 * `IN OUT` modes, types, order, return types, and routine modifiers remain
 * significant.
 *
 * @param state - Parser state.
 * @param start - First heading token.
 * @param end - Last heading token.
 * @returns Case-normalized heading without parameter defaults or an explicit lone `IN`.
 */
export const normalizedPairingHeading = (state: OracleParserStateType, start: number, end: number): string => {
	const parts: string[] = [];
	let depth = 0;
	let defaultDepth = 0;
	let skippingDefault = false;

	for (let index = Math.max(0, start); index <= end; index = state.cursor.next(index)) {
		const text = state.cursor.text(index);

		if (skippingDefault) {
			if (text === '(') {
				defaultDepth += 1;
			} else if (text === ')') {
				if (defaultDepth === 0) {
					skippingDefault = false;
					depth = Math.max(0, depth - 1);
					parts.push(normalizedPart(state, index));
				} else {
					defaultDepth -= 1;
				}
			} else if (defaultDepth === 0 && text === ',') {
				skippingDefault = false;
				parts.push(text);
			}

			continue;
		}

		if (text === '(') {
			depth += 1;
		} else if (text === ')') {
			depth = Math.max(0, depth - 1);
		} else if (startsParameterDefault(state, index, depth)) {
			skippingDefault = true;
			defaultDepth = 0;
			continue;
		} else if (isOmittedInputMode(state, index, depth)) {
			continue;
		}

		parts.push(normalizedPart(state, index));
	}

	return parts.join('').toUpperCase();
};

export const findWord = (state: OracleParserStateType, start: number, end: number, words: readonly string[]): number | null => {
	for (let index = Math.max(0, start); index <= end; index = state.cursor.next(index)) {
		if (words.includes(state.cursor.upper(index))) {
			return index;
		}
	}

	return null;
};

export const findToken = (state: OracleParserStateType, start: number, end: number, token: string): number | null => {
	for (let index = Math.max(0, start); index <= end; index = state.cursor.next(index)) {
		if (state.cursor.text(index) === token) {
			return index;
		}
	}

	return null;
};
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
const TYPE_SHAPE_KEYWORDS = new Set([
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

export const typeReferencesOf = (state: OracleParserStateType, start: number, end: number): readonly OracleTypeReferenceType[] => {
	const references: OracleTypeReferenceType[] = [];
	let declaredName: OracleNameReadType | null = null;

	for (let index = Math.max(0, start); index <= end; index = state.cursor.next(index)) {
		if (!TYPE_ANCHORS.has(state.cursor.upper(index))) {
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
			references.push({
				name: oracleNameOf({parts: name.parts}),
				range: rangeOf(state, name.startIndex, index),
				rowType: state.cursor.upper(index) === '%ROWTYPE',
			});
		}
	}

	if (references.length === 0 && declaredName !== null) {
		references.push({
			name: oracleNameOf({parts: declaredName.parts}),
			range: rangeOf(state, declaredName.startIndex, declaredName.endIndex),
			rowType: false,
		});
	}

	return references;
};
const argumentInfo = (
	state: OracleParserStateType,
	open: number,
): Readonly<{count: number; names: readonly string[]; arguments: readonly OracleReferenceArgumentType[]}> => {
	const boundary = state.cursor.findDeclarationEnd(open);
	const close = state.cursor.findBalancedClose(open, boundary);

	if (close === null || state.cursor.next(open) >= close) {
		return {count: 0, names: [], arguments: []};
	}

	const ranges = state.cursor.splitTopLevel(state.cursor.next(open), state.cursor.previous(close), ',');
	const argumentsWithNames = ranges.map((range) => {
		const first = state.cursor.readQualifiedName(range.start);

		if (first === null) {
			return {range: rangeOf(state, range.start, range.end), name: null};
		}

		const association = state.cursor.text(first.nextIndex);
		const named = association === '=>' || (association === '=' && state.cursor.text(state.cursor.next(first.nextIndex)) === '>');

		return {range: rangeOf(state, range.start, range.end), name: named ? (first.parts.at(-1)?.canonical ?? null) : null};
	});

	return {
		count: ranges.length,
		names: argumentsWithNames.flatMap((argument) => (argument.name === null ? [] : [argument.name])),
		arguments: argumentsWithNames,
	};
};
const addReference = (
	state: OracleParserStateType,
	input: Readonly<{
		name: OracleNameReadType;
		start: number;
		end: number;
		unit: number;
		enclosing: number;
		kind: OracleReferenceSiteType['kind'];
		argumentCount: number | null;
		argumentNames: readonly string[];
		arguments?: readonly OracleReferenceArgumentType[] | undefined;
		rowType: boolean;
		sql?: boolean | undefined;
		forBound?: boolean | undefined;
		typeSize?: boolean | undefined;
		iteratorBase?: boolean | undefined;
		usage?: number | undefined;
	}>,
): void => {
	const parsedName: OracleNameType = oracleNameOf({parts: input.name.parts});
	const range = rangeOf(state, input.start, input.end);

	state.references.push({
		name: parsedName,
		range,
		nameRange: rangeOf(state, input.name.endIndex, input.name.endIndex),
		unit: input.unit,
		enclosing: input.enclosing,
		kind: input.kind,
		argumentCount: input.argumentCount,
		argumentNames: input.argumentNames,
		...(input.arguments === undefined ? {} : {arguments: input.arguments}),
		rowType: input.rowType,
		...(input.sql === undefined ? {} : {sql: input.sql}),
		...(input.forBound === undefined ? {} : {forBound: input.forBound}),
		...(input.typeSize === undefined ? {} : {typeSize: input.typeSize}),
		...(input.iteratorBase === undefined ? {} : {iteratorBase: input.iteratorBase}),
		...(input.usage === undefined ? {} : {usage: input.usage}),
	});

	if (input.name.parts.length < 2) {
		return;
	}

	const targetParts = input.name.parts.length >= 3 ? input.name.parts.slice(0, 2) : input.name.parts.slice(0, 1);
	const dependencyKind = input.kind === 'call' ? 'package-call' : input.kind === 'type-anchor' ? 'type-reference' : 'package-reference';

	state.dependencies.push({
		targetName: oracleNameOf({parts: targetParts}),
		memberName: input.name.parts.at(-1) ?? null,
		range,
		unit: input.unit,
		enclosing: input.enclosing,
		kind: dependencyKind,
	});
};
const addNameSite = (
	state: OracleParserStateType,
	input: Readonly<{
		name: OracleNameReadType;
		index: number;
		unit: number;
		enclosing: number;
		forceWrite?: boolean | undefined;
		sql?: boolean | undefined;
		forBound?: boolean | undefined;
		typeSize?: boolean | undefined;
		iteratorBase?: boolean | undefined;
	}>,
): number => {
	const name = nameWithChain(state, input.name, input.index);
	const start = name.startIndex;
	const after = input.name.nextIndex;
	addChainPrefixes({
		state,
		name,
		unit: input.unit,
		enclosing: input.enclosing,
		sql: input.sql,
		forBound: input.forBound,
		typeSize: input.typeSize,
		emit: addReference,
	});

	if (TYPE_ANCHORS.has(state.cursor.upper(after))) {
		addReference(state, {
			name,
			start,
			end: after,
			unit: input.unit,
			enclosing: input.enclosing,
			kind: 'type-anchor',
			argumentCount: null,
			argumentNames: [],
			rowType: state.cursor.upper(after) === '%ROWTYPE',
			sql: input.sql,
			forBound: input.forBound,
			typeSize: input.typeSize,
			iteratorBase: input.iteratorBase,
			usage: 8,
		});
		return after;
	}

	const call = state.cursor.text(after) === '(' ? argumentInfo(state, after) : null;
	const writeTarget = call === null && (input.forceWrite === true || state.cursor.text(after) === ':=');

	addReference(state, {
		name,
		start,
		end: input.name.endIndex,
		unit: input.unit,
		enclosing: input.enclosing,
		kind: call === null ? 'reference' : 'call',
		argumentCount: call?.count ?? null,
		argumentNames: call?.names ?? [],
		...(call === null ? {} : {arguments: call.arguments}),
		rowType: false,
		sql: input.sql,
		forBound: input.forBound,
		typeSize: input.typeSize,
		iteratorBase: input.iteratorBase,
		usage: call === null ? (writeTarget ? 4 : 2) : 1,
	});

	return input.name.endIndex;
};
export const collectReferences = (input: Readonly<{state: OracleParserStateType; start: number; end: number; enclosing: number; unit: number}>): void => {
	const {state, start, end, enclosing, unit} = input;
	let index = Math.max(0, start);
	let intoTarget = false;
	let sql = false;
	let forHeader = false;
	const iteratorNames = new Set<string>();

	while (index <= end && index < state.cursor.length) {
		const pragmaEnd = pragmaArgumentEnd(state, index);

		if (pragmaEnd !== null) {
			index = pragmaEnd;
			continue;
		}

		sql = isSqlStart(state, index) || (sql && !isSqlEnd(state, index));
		addLoopIterator(state, index, iteratorNames);
		forHeader = nextForHeader(state, index, forHeader);
		const {consumed, intoTarget: nextInto} = nextIntoState({state, index, intoTarget});
		intoTarget = nextInto;

		if (consumed) {
			index = state.cursor.next(index);
			continue;
		}

		if (isIgnoredIdentifier(state, index)) {
			index = state.cursor.next(index);
			continue;
		}

		const name = state.cursor.readQualifiedName(index);

		if (name === null) {
			index = state.cursor.next(index);
			continue;
		}

		if (
			isDeclarationName(state, index, name) ||
			state.cursor.word(state.cursor.previous(index), 'END') ||
			isNamedAssociation(state, state.cursor.next(name.endIndex))
		) {
			index = state.cursor.next(name.endIndex);
			continue;
		}

		index = state.cursor.next(
			addNameSite(state, {
				name,
				index,
				unit,
				enclosing,
				forceWrite: intoTarget,
				sql,
				forBound: forHeader,
				typeSize: isTypeSizeArgument(state, index),
				iteratorBase: iteratorNames.has(name.parts[0]?.canonical ?? ''),
			}),
		);
	}
};
export const splitObjectName = (name: OracleNameReadType, defaultSchema: string): Readonly<{schema: OracleNamePartType; object: OracleNamePartType}> => {
	const object = name.parts.at(-1) ?? namePartOf('');
	const schema = name.parts.length >= 2 ? (name.parts[0] ?? namePartOf(defaultSchema)) : namePartOf(defaultSchema);

	return {schema, object};
};
