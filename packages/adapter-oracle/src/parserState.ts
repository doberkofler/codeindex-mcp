import {OracleDiagnosticCollector, type OracleDiagnosticCodeType} from './diagnostics.ts';
import {namePartOf, oracleNameOf, type OracleNameType} from './name.ts';
import {addChainPrefixes, nameWithChain} from './referenceChains.ts';
import {
	addLoopIterator,
	addPragmaReference,
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
import {addBulkCollectSite, argumentShapeOf, assignFollows, forRangeAt, statementStart} from './referenceArguments.ts';
import {type OracleNameReadType, type TokenCursor} from './tokenCursor.ts';
import {
	type OracleDeclarationType,
	type OracleDependencySiteType,
	type OracleRangeType,
	type OracleReferenceArgumentType,
	type OracleReferenceSiteType,
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
	const argumentsWithNames = ranges.map((range) => ({range: rangeOf(state, range.start, range.end), ...argumentShapeOf(state, range)}));

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
		forRange?: boolean | undefined;
		typeSize?: boolean | undefined;
		iteratorBase?: boolean | undefined;
		statementCall?: boolean | undefined;
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
		...(input.forRange === undefined ? {} : {forRange: input.forRange}),
		...(input.typeSize === undefined ? {} : {typeSize: input.typeSize}),
		...(input.iteratorBase === undefined ? {} : {iteratorBase: input.iteratorBase}),
		...(input.statementCall === undefined ? {} : {statementCall: input.statementCall}),
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
const addTypeAnchorSite = (
	state: OracleParserStateType,
	input: Readonly<{
		unit: number;
		enclosing: number;
		sql?: boolean | undefined;
		forBound?: boolean | undefined;
		forRange?: boolean | undefined;
		typeSize?: boolean | undefined;
		iteratorBase?: boolean | undefined;
	}>,
	node: Readonly<{name: OracleNameReadType; start: number; after: number}>,
): number | null => {
	const {name, start, after} = node;
	if (!TYPE_ANCHORS.has(state.cursor.upper(after))) {
		return null;
	}

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
		forRange: input.forRange,
		typeSize: input.typeSize,
		iteratorBase: input.iteratorBase,
		usage: 8,
	});

	return after;
};

type CallShapeType = Readonly<{
	siteOf: (
		value: Readonly<{
			name: OracleNameReadType;
			start: number;
			input: {
				unit: number;
				enclosing: number;
				sql?: boolean | undefined;
				forBound?: boolean | undefined;
				forRange?: boolean | undefined;
				typeSize?: boolean | undefined;
				iteratorBase?: boolean | undefined;
			};
		}>,
	) => Parameters<typeof addReference>[1];
}>;

const callShapeOf = (state: OracleParserStateType, after: number, forceWrite: boolean): CallShapeType => {
	const call = state.cursor.text(after) === '(' ? argumentInfo(state, after) : null;
	const writeTarget = call === null && (forceWrite || state.cursor.text(after) === ':=');
	// `collection(index)(index) := value` writes a nested element, so the base
	// name is an assignment target rather than a call.
	const indexedWrite = call !== null && (assignFollows(state, after) || forceWrite);
	const reference = call === null || indexedWrite;
	const argumentProperties = call === null ? {} : {arguments: call.arguments};
	const usage = reference ? (writeTarget || indexedWrite ? 4 : 2) : 1;

	return {
		siteOf: ({name, start, input}) => {
			const statementProperties = reference ? {} : {statementCall: statementStart(state, start)};

			return {
				name,
				start,
				end: name.endIndex,
				unit: input.unit,
				enclosing: input.enclosing,
				kind: reference ? 'reference' : 'call',
				argumentCount: call?.count ?? null,
				argumentNames: call?.names ?? [],
				...argumentProperties,
				rowType: false,
				sql: input.sql,
				forBound: input.forBound,
				forRange: input.forRange,
				typeSize: input.typeSize,
				iteratorBase: input.iteratorBase,
				...statementProperties,
				usage,
			};
		},
	};
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
		forRange?: boolean | undefined;
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
		forRange: input.forRange,
		typeSize: input.typeSize,
		emit: addReference,
	});

	const anchorEnd = addTypeAnchorSite(state, input, {name, start, after});

	if (anchorEnd !== null) {
		return anchorEnd;
	}

	const shape = callShapeOf(state, after, input.forceWrite === true);

	addReference(state, shape.siteOf({name, start, input}));

	return input.name.endIndex;
};
type ScanFlagsType = Readonly<{sql: boolean; forHeader: boolean; forRange: boolean; intoTarget: boolean; consumed: boolean}>;

const nextScanFlags = (input: Readonly<{state: OracleParserStateType; index: number; flags: ScanFlagsType; iterators: Set<string>}>): ScanFlagsType => {
	const {state, index, flags, iterators} = input;

	addLoopIterator(state, index, iterators);

	const forRangeSeed = state.cursor.word(index, 'FOR') ? forRangeAt(state, index) : flags.forRange;
	const forHeader = nextForHeader(state, index, flags.forHeader);
	const {consumed, intoTarget} = nextIntoState({state, index, intoTarget: flags.intoTarget});

	return {
		sql: isSqlStart(state, index) || (flags.sql && !isSqlEnd(state, index)),
		forHeader,
		forRange: forHeader && forRangeSeed,
		intoTarget,
		consumed,
	};
};

const skipNameAt = (state: OracleParserStateType, index: number, name: OracleNameReadType): boolean =>
	isDeclarationName(state, index, name) ||
	state.cursor.word(state.cursor.previous(index), 'END') ||
	isNamedAssociation(state, state.cursor.next(name.endIndex));

/**
 * Collects every reference site in one declaration range.
 *
 * @param input - Parser state, token range, and enclosing declaration.
 */
export const collectReferences = (input: Readonly<{state: OracleParserStateType; start: number; end: number; enclosing: number; unit: number}>): void => {
	const {state, start, end, enclosing, unit} = input;
	let index = Math.max(0, start);
	let flags: ScanFlagsType = {sql: false, forHeader: false, forRange: false, intoTarget: false, consumed: false};
	const iteratorNames = new Set<string>();

	while (index <= end && index < state.cursor.length) {
		const pragmaEnd = pragmaArgumentEnd(state, index);

		if (pragmaEnd !== null) {
			addPragmaReference({
				state,
				index,
				unit,
				enclosing,
				emit: (site) => {
					addReference(state, {...site, kind: 'reference', argumentCount: null, argumentNames: [], rowType: false});
				},
			});
			index = pragmaEnd;
			continue;
		}

		flags = nextScanFlags({state, index, flags, iterators: iteratorNames});

		if (state.cursor.word(index, 'BULK')) {
			addBulkCollectSite(state, index, unit, enclosing);
		}

		if (flags.consumed || isIgnoredIdentifier(state, index)) {
			index = state.cursor.next(index);
			continue;
		}

		const name = state.cursor.readQualifiedName(index);

		if (name === null) {
			index = state.cursor.next(index);
			continue;
		}

		if (skipNameAt(state, index, name)) {
			index = state.cursor.next(name.endIndex);
			continue;
		}

		index = state.cursor.next(
			addNameSite(state, {
				name,
				index,
				unit,
				enclosing,
				forceWrite: flags.intoTarget,
				sql: flags.sql,
				forBound: flags.forHeader,
				forRange: flags.forRange,
				typeSize: isTypeSizeArgument(state, index),
				iteratorBase: iteratorNames.has(name.parts[0]?.canonical ?? ''),
			}),
		);
	}
};
