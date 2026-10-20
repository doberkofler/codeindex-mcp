import {OracleDiagnosticCollector, type OracleDiagnosticCodeType} from './diagnostics.ts';
import {namePartOf, oracleNameOf, type OracleNamePartType, type OracleNameType} from './name.ts';
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

export const normalizedTokens = (state: OracleParserStateType, start: number, end: number): string => {
	const parts: string[] = [];

	for (let index = Math.max(0, start); index <= end; index = state.cursor.next(index)) {
		const text = state.cursor.text(index);
		parts.push(state.cursor.identifier(index) ? namePartOf(text).canonical : text);
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

const addNameSite = (state: OracleParserStateType, input: Readonly<{name: OracleNameReadType; index: number; unit: number; enclosing: number}>): number => {
	const after = input.name.nextIndex;

	if (TYPE_ANCHORS.has(state.cursor.upper(after))) {
		addReference(state, {
			name: input.name,
			start: input.index,
			end: after,
			unit: input.unit,
			enclosing: input.enclosing,
			kind: 'type-anchor',
			argumentCount: null,
			argumentNames: [],
			rowType: state.cursor.upper(after) === '%ROWTYPE',
			usage: 8,
		});
		return after;
	}

	const call = state.cursor.text(after) === '(' ? argumentInfo(state, after) : null;
	const writeTarget = call === null && state.cursor.text(after) === ':=';

	addReference(state, {
		name: input.name,
		start: input.index,
		end: input.name.endIndex,
		unit: input.unit,
		enclosing: input.enclosing,
		kind: call === null ? 'reference' : 'call',
		argumentCount: call?.count ?? null,
		argumentNames: call?.names ?? [],
		...(call === null ? {} : {arguments: call.arguments}),
		rowType: false,
		usage: call === null ? (writeTarget ? 4 : 2) : 1,
	});

	return input.name.endIndex;
};

export const collectReferences = (input: Readonly<{state: OracleParserStateType; start: number; end: number; enclosing: number; unit: number}>): void => {
	const {state, start, end, enclosing, unit} = input;
	let index = Math.max(0, start);

	while (index <= end && index < state.cursor.length) {
		if (!state.cursor.identifier(index)) {
			index = state.cursor.next(index);
			continue;
		}

		const name = state.cursor.readQualifiedName(index);

		if (name === null) {
			index = state.cursor.next(index);
			continue;
		}

		const declarationOffset = state.definitionStarts.has(state.cursor.token(index)?.startOffset ?? -1);
		const qualifiedDeclarationOffset = state.definitionStarts.has(state.cursor.token(name.endIndex)?.startOffset ?? -1);

		if (declarationOffset || qualifiedDeclarationOffset) {
			index = state.cursor.next(name.endIndex);
			continue;
		}

		if (state.cursor.word(state.cursor.previous(index), 'END')) {
			index = state.cursor.next(name.endIndex);
			continue;
		}

		const after = state.cursor.next(name.endIndex);
		const namedAssociation = state.cursor.text(after) === '=>' || (state.cursor.text(after) === '=' && state.cursor.text(state.cursor.next(after)) === '>');

		if (namedAssociation) {
			index = state.cursor.next(name.endIndex);
			continue;
		}

		index = state.cursor.next(addNameSite(state, {name, index, unit, enclosing}));
	}
};

export const splitObjectName = (name: OracleNameReadType, defaultSchema: string): Readonly<{schema: OracleNamePartType; object: OracleNamePartType}> => {
	const object = name.parts.at(-1) ?? namePartOf('');
	const schema = name.parts.length >= 2 ? (name.parts[0] ?? namePartOf(defaultSchema)) : namePartOf(defaultSchema);

	return {schema, object};
};
