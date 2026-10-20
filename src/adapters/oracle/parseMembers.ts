import {ORACLE_DIAGNOSTIC} from './diagnostics.ts';
import {namePartOf} from './name.ts';
import {
	addDeclaration,
	collectReferences,
	findToken,
	findWord,
	normalizedTokens,
	rangeOf,
	typeReferencesOf,
	warnAt,
	type OracleParserStateType,
} from './parserState.ts';
import {type OracleDeclarationKindType, type OracleParameterType} from './syntax.ts';

type DeclarationInputType = Readonly<{state: OracleParserStateType; start: number; parent: number; unit: number; exported: boolean}>;

type NamedDeclarationInputType = DeclarationInputType & Readonly<{kind: OracleDeclarationKindType}>;

export type OracleParameterSpecType = Omit<OracleParameterType, 'nameRange'> & Readonly<{nameRange: ReturnType<typeof rangeOf>}>;

const addParameter = (
	input: Readonly<{state: OracleParserStateType; parent: number; unit: number; exported: boolean; parameter: OracleParameterSpecType}>,
): void => {
	addDeclaration(input.state, {
		kind: 'parameter',
		name: input.parameter.name,
		range: input.parameter.range,
		nameRange: input.parameter.nameRange,
		parent: input.parent,
		unit: input.unit,
		exported: input.exported,
		parameters: [],
		typeReferences: input.parameter.typeReferences,
	});
};

const parseParameter = (state: OracleParserStateType, start: number, end: number): OracleParameterSpecType | null => {
	const name = state.cursor.readQualifiedName(start);

	if (name === null) {
		return null;
	}

	let cursor = name.nextIndex;
	let mode: OracleParameterType['mode'] = 'IN';

	if (state.cursor.word(cursor, 'IN') && state.cursor.word(state.cursor.next(cursor), 'OUT')) {
		mode = 'IN OUT';
		cursor = state.cursor.next(state.cursor.next(cursor));
	} else if (state.cursor.word(cursor, 'OUT')) {
		mode = 'OUT';
		cursor = state.cursor.next(cursor);
	} else if (state.cursor.word(cursor, 'IN')) {
		cursor = state.cursor.next(cursor);
	}

	if (state.cursor.word(cursor, 'NOCOPY')) {
		cursor = state.cursor.next(cursor);
	}

	const defaultIndex = findWord(state, cursor, end, ['DEFAULT', ':=']);
	const typeEnd = defaultIndex === null ? end : state.cursor.previous(defaultIndex);

	return {
		name: name.parts.at(-1) ?? namePartOf(''),
		nameRange: rangeOf(state, name.endIndex, name.endIndex),
		range: rangeOf(state, start, end),
		mode,
		hasDefault: defaultIndex !== null,
		typeText: normalizedTokens(state, cursor, typeEnd),
		typeReferences: typeReferencesOf(state, cursor, typeEnd),
	};
};

export const parseParameterList = (
	state: OracleParserStateType,
	open: number,
): Readonly<{parameters: readonly OracleParameterSpecType[]; nextIndex: number}> => {
	const boundary = state.cursor.findDeclarationEnd(open);
	const close = state.cursor.findBalancedClose(open, boundary);

	if (close === null) {
		warnAt(state, ORACLE_DIAGNOSTIC.malformedDeclaration, 'Routine has an unclosed parameter list', open);
		return {parameters: [], nextIndex: state.cursor.next(open)};
	}

	const parameters = state.cursor
		.splitTopLevel(state.cursor.next(open), state.cursor.previous(close), ',')
		.map((range) => parseParameter(state, range.start, range.end))
		.filter((parameter): parameter is OracleParameterSpecType => parameter !== null);

	return {parameters, nextIndex: state.cursor.next(close)};
};

export const addParameters = (
	input: Readonly<{
		state: OracleParserStateType;
		parameters: readonly OracleParameterSpecType[];
		parent: number;
		unit: number;
		exported: boolean;
	}>,
): void => {
	for (const parameter of input.parameters) {
		addParameter({...input, parameter});
	}
};

const parseNamedDeclaration = (input: NamedDeclarationInputType): number => {
	const {state} = input;
	const end = state.cursor.findDeclarationEnd(input.start);
	const name = state.cursor.readQualifiedName(
		input.kind === 'variable' || input.kind === 'constant' || input.kind === 'exception' ? input.start : state.cursor.next(input.start),
	);

	if (name === null) {
		return state.cursor.next(end);
	}

	const index = addDeclaration(state, {
		kind: input.kind,
		name: name.parts.at(-1) ?? namePartOf(''),
		range: rangeOf(state, input.start, end),
		nameRange: rangeOf(state, name.endIndex, name.endIndex),
		parent: input.parent,
		unit: input.unit,
		exported: input.exported,
		parameters: [],
		typeReferences: typeReferencesOf(state, name.nextIndex, end),
	});

	collectReferences({state, start: name.nextIndex, end, enclosing: index, unit: input.unit});
	return state.cursor.next(end);
};

export const parseSubtypeDeclaration = (input: DeclarationInputType): number => parseNamedDeclaration({...input, kind: 'subtype'});

export const parseCursorDeclaration = (input: DeclarationInputType): number => {
	const {state} = input;
	const end = state.cursor.findDeclarationEnd(input.start);
	const name = state.cursor.readQualifiedName(state.cursor.next(input.start));

	if (name === null) {
		return state.cursor.next(end);
	}

	const parameterList = state.cursor.text(name.nextIndex) === '(' ? parseParameterList(state, name.nextIndex) : null;
	const definition = findWord(state, name.nextIndex, end, ['IS', 'AS']);
	const body = definition !== null;
	const headingEnd = definition === null ? state.cursor.previous(end) : state.cursor.previous(definition);
	const unitKind = state.units[input.unit]?.kind;
	const form = body ? 'full_definition' : unitKind === 'package-body' ? 'body_forward' : 'specification';
	const index = addDeclaration(state, {
		kind: 'cursor',
		name: name.parts.at(-1) ?? namePartOf(''),
		range: rangeOf(state, input.start, end),
		nameRange: rangeOf(state, name.endIndex, name.endIndex),
		parent: input.parent,
		unit: input.unit,
		exported: input.exported,
		parameters: parameterList?.parameters ?? [],
		typeReferences: typeReferencesOf(state, name.nextIndex, end),
		heading: normalizedTokens(state, input.start, headingEnd),
		form,
	});

	if (parameterList !== null) {
		addParameters({state, parameters: parameterList.parameters, parent: index, unit: input.unit, exported: input.exported});
	}

	collectReferences({state, start: name.nextIndex, end, enclosing: index, unit: input.unit});
	return state.cursor.next(end);
};

export const parseValueDeclaration = (input: DeclarationInputType): number => {
	const {state} = input;
	const name = state.cursor.readQualifiedName(input.start);
	const end = state.cursor.findDeclarationEnd(input.start);
	const kind: OracleDeclarationKindType =
		name !== null && state.cursor.word(name.nextIndex, 'EXCEPTION')
			? 'exception'
			: findWord(state, name?.nextIndex ?? input.start, end, ['CONSTANT']) === null
				? 'variable'
				: 'constant';

	return parseNamedDeclaration({...input, kind});
};

const typeKind = (state: OracleParserStateType, shape: number): OracleDeclarationKindType | null => {
	if (state.cursor.word(shape, 'RECORD')) {
		return 'record_type';
	}

	if (state.cursor.word(shape, 'TABLE') || state.cursor.word(shape, 'VARRAY')) {
		return 'collection_type';
	}

	return state.cursor.word(shape, 'REF') ? 'cursor' : null;
};

const parseFields = (input: Readonly<{state: OracleParserStateType; shape: number; end: number; parent: number; unit: number; exported: boolean}>): void => {
	const {state} = input;
	const open = findToken(state, input.shape, input.end, '(');

	if (open === null) {
		return;
	}

	const close = state.cursor.findBalancedClose(open, input.end);

	if (close === null) {
		warnAt(state, ORACLE_DIAGNOSTIC.malformedDeclaration, 'Record type has an unclosed field list', open);
		return;
	}

	for (const range of state.cursor.splitTopLevel(state.cursor.next(open), state.cursor.previous(close), ',')) {
		const name = state.cursor.readQualifiedName(range.start);

		if (name === null) {
			continue;
		}

		const index = addDeclaration(state, {
			kind: 'field',
			name: name.parts.at(-1) ?? namePartOf(''),
			range: rangeOf(state, range.start, range.end),
			nameRange: rangeOf(state, name.endIndex, name.endIndex),
			parent: input.parent,
			unit: input.unit,
			exported: input.exported,
			parameters: [],
			typeReferences: typeReferencesOf(state, name.nextIndex, range.end),
		});

		collectReferences({state, start: name.nextIndex, end: range.end, enclosing: index, unit: input.unit});
	}
};

export const parseTypeDeclaration = (input: DeclarationInputType): number => {
	const {state} = input;
	const end = state.cursor.findDeclarationEnd(input.start);
	const name = state.cursor.readQualifiedName(state.cursor.next(input.start));

	if (name === null) {
		warnAt(state, ORACLE_DIAGNOSTIC.parse, 'Unable to read type name', input.start);
		return state.cursor.next(end);
	}

	const definition = findWord(state, name.nextIndex, end, ['IS', 'AS']);

	if (definition === null) {
		return state.cursor.next(end);
	}

	const shape = state.cursor.next(definition);
	const kind = typeKind(state, shape);

	if (kind === null) {
		return state.cursor.next(end);
	}

	const index = addDeclaration(state, {
		kind,
		name: name.parts.at(-1) ?? namePartOf(''),
		range: rangeOf(state, input.start, end),
		nameRange: rangeOf(state, name.endIndex, name.endIndex),
		parent: input.parent,
		unit: input.unit,
		exported: input.exported,
		parameters: [],
		typeReferences: typeReferencesOf(state, shape, end),
	});

	if (kind === 'record_type') {
		const open = findToken(state, shape, end, '(');

		parseFields({...input, shape, end, parent: index});
		collectReferences({state, start: shape, end: open === null ? end : state.cursor.previous(open), enclosing: index, unit: input.unit});
	} else {
		collectReferences({state, start: shape, end, enclosing: index, unit: input.unit});
	}

	return state.cursor.next(end);
};
