import {ORACLE_DIAGNOSTIC} from './diagnostics.ts';
import {typeReferencesOf} from './referenceArguments.ts';
import {namePartOf, splitObjectName} from './name.ts';
import {
	addParameters,
	parseCursorDeclaration,
	parseParameterList,
	parseSubtypeDeclaration,
	parseTypeDeclaration,
	parseValueDeclaration,
} from './parseMembers.ts';
import {
	collectReferences,
	createParserState,
	normalizedPairingHeading,
	rangeOf,
	recoverMember,
	recoverTopLevel,
	statementEnd,
	warnAt,
	type OracleParserStateType,
} from './parserState.ts';
import {parseNestedBlockDeclarations} from './nestedBlocks.ts';
import {routineFormOf} from './routineForm.ts';
import {TokenCursor} from './tokenCursor.ts';
import {type OracleDeclarationType, type OracleParseResultType, type OracleUnitKindType, type OracleUnitType} from './syntax.ts';
import {type OracleTokenType} from './tokenize.ts';

type ParserInputType = Readonly<{tokens: readonly OracleTokenType[]; path: string; defaultSchema: string}>;

type RoutineHeaderType = Readonly<{
	name: NonNullable<ReturnType<TokenCursor['readQualifiedName']>>;
	parameters: Awaited<ReturnType<typeof parseParameterList>>['parameters'];
	signature: Readonly<{index: number; nextIndex: number; start: number; hasBody: boolean}>;
}>;

/**
 * Tolerant structural parser for Oracle package and routine declarations.
 *
 * The parser intentionally models declarations and name sites, not a complete
 * PL/SQL abstract syntax tree. Malformed declarations recover at the next
 * semicolon, block end, unit boundary, or SQL*Plus slash.
 */
class OracleDeclarationParser {
	readonly #state: OracleParserStateType;

	public constructor(input: ParserInputType) {
		this.#state = createParserState(new TokenCursor(input.tokens), input.defaultSchema, input.path);
	}

	/**
	 * Parses every top-level unit in one source file.
	 *
	 * @returns Units, declarations, name sites, dependency candidates, and diagnostics.
	 */
	public parseFile(): OracleParseResultType {
		let index = 0;

		while (index < this.#state.cursor.length) {
			const declarationIndex = this.#declarationKeyword(index);
			const unitKind = this.#unitKind(declarationIndex);

			if (unitKind === 'package-spec' || unitKind === 'package-body') {
				index = this.#parsePackage(index, declarationIndex, unitKind === 'package-body');
			} else if (unitKind === 'procedure' || unitKind === 'function') {
				index = this.#parseRoutine({keyword: declarationIndex, unitStart: index, parent: null, unit: -1, exported: true, kind: unitKind});
			} else if (this.#state.cursor.text(index).startsWith('$')) {
				index = this.#state.cursor.next(this.#state.cursor.findDirectiveEnd(index));
			} else {
				index = this.#state.cursor.next(index);
			}
		}

		return {
			units: this.#state.units,
			declarations: this.#state.declarations,
			references: this.#state.references,
			dependencies: this.#state.dependencies,
			diagnostics: this.#state.diagnostics.finish(),
		};
	}

	#declarationKeyword(index: number): number {
		if (!this.#state.cursor.word(index, 'CREATE')) {
			return index;
		}

		let cursor = this.#state.cursor.next(index);

		if (this.#state.cursor.word(cursor, 'OR') && this.#state.cursor.word(this.#state.cursor.next(cursor), 'REPLACE')) {
			cursor = this.#state.cursor.next(this.#state.cursor.next(cursor));
		}

		while (this.#state.cursor.word(cursor, 'EDITIONABLE') || this.#state.cursor.word(cursor, 'NONEDITIONABLE') || this.#state.cursor.word(cursor, 'FORCE')) {
			cursor = this.#state.cursor.next(cursor);
		}

		return cursor;
	}

	#unitKind(index: number): OracleUnitKindType | null {
		if (this.#state.cursor.word(index, 'PACKAGE')) {
			return this.#state.cursor.word(this.#state.cursor.next(index), 'BODY') ? 'package-body' : 'package-spec';
		}

		if (this.#state.cursor.word(index, 'PROCEDURE')) {
			return 'procedure';
		}

		return this.#state.cursor.word(index, 'FUNCTION') ? 'function' : null;
	}

	#parsePackage(unitStart: number, packageIndex: number, body: boolean): number {
		let cursor = this.#state.cursor.next(packageIndex);

		if (body) {
			cursor = this.#state.cursor.next(cursor);
		}

		const name = this.#state.cursor.readQualifiedName(cursor);

		if (name === null) {
			warnAt(this.#state, ORACLE_DIAGNOSTIC.parse, 'Unable to read package name', cursor);
			return recoverTopLevel(this.#state, cursor);
		}

		cursor = name.nextIndex;

		while (
			!this.#state.cursor.eof(cursor) &&
			!this.#state.cursor.word(cursor, 'IS') &&
			!this.#state.cursor.word(cursor, 'AS') &&
			this.#state.cursor.text(cursor) !== ';'
		) {
			if (this.#state.cursor.word(cursor, 'WRAPPED')) {
				warnAt(this.#state, ORACLE_DIAGNOSTIC.wrappedUnit, 'Wrapped Oracle source is outside O1 scope', cursor);
				return this.#recoverUnit(cursor);
			}

			cursor = this.#state.cursor.next(cursor);
		}

		if (!this.#state.cursor.word(cursor, 'IS') && !this.#state.cursor.word(cursor, 'AS')) {
			warnAt(this.#state, ORACLE_DIAGNOSTIC.malformedDeclaration, 'Package declaration is missing IS or AS', packageIndex);
			return recoverTopLevel(this.#state, cursor);
		}

		const parsedName = splitObjectName(name, this.#state.defaultSchema);
		const unitIndex = this.#state.units.length;
		const declarationIndex = this.#state.declarations.length;

		this.#state.declarations.push({
			kind: 'package',
			name: parsedName.object,
			range: rangeOf(this.#state, unitStart, name.endIndex),
			nameRange: rangeOf(this.#state, name.endIndex, name.endIndex),
			parent: null,
			unit: unitIndex,
			exported: !body,
			parameters: [],
			typeReferences: [],
		});
		this.#state.definitionStarts.add(this.#state.cursor.token(name.endIndex)?.startOffset ?? -1);
		this.#state.units.push({
			kind: body ? 'package-body' : 'package-spec',
			schema: parsedName.schema,
			name: parsedName.object,
			canonical: `${parsedName.schema.canonical}.${parsedName.object.canonical}`,
			range: rangeOf(this.#state, unitStart, name.endIndex),
			nameRange: rangeOf(this.#state, name.endIndex, name.endIndex),
			declaration: declarationIndex,
		});

		cursor = this.#state.cursor.next(cursor);
		const end = this.#packageMembers(cursor, declarationIndex, unitIndex, !body);

		if (end === null) {
			warnAt(this.#state, ORACLE_DIAGNOSTIC.malformedDeclaration, 'Package declaration has no terminating END', packageIndex);
			return recoverTopLevel(this.#state, cursor);
		}

		this.#updateRange(declarationIndex, unitIndex, unitStart, statementEnd(end.nextIndex));

		if (end.bodyStart !== undefined) {
			parseNestedBlockDeclarations({
				state: this.#state,
				start: this.#state.cursor.next(end.bodyStart),
				end: end.endIndex,
				parent: declarationIndex,
				unit: unitIndex,
				parseMember: (memberCursor, memberParent, memberUnit, memberExported) => this.#parseMember(memberCursor, memberParent, memberUnit, memberExported),
			});
			collectReferences({state: this.#state, start: this.#state.cursor.next(end.bodyStart), end: end.endIndex, enclosing: declarationIndex, unit: unitIndex});
		}

		return end.nextIndex;
	}

	#packageMembers(start: number, parent: number, unit: number, exported: boolean): Readonly<{endIndex: number; nextIndex: number; bodyStart?: number}> | null {
		let cursor = start;

		while (cursor < this.#state.cursor.length) {
			if (this.#state.cursor.isSlashBoundary(cursor)) {
				return null;
			}

			if (this.#state.cursor.word(cursor, 'END')) {
				return this.#packageEnd(cursor);
			}

			if (this.#state.cursor.word(cursor, 'BEGIN')) {
				return {...this.#state.cursor.findBlockEnd(cursor), bodyStart: cursor};
			}

			if (this.#state.cursor.text(cursor) === ';' || this.#state.cursor.text(cursor) === 'DECLARE') {
				cursor = this.#state.cursor.next(cursor);
				continue;
			}

			if (this.#state.cursor.text(cursor).startsWith('$')) {
				cursor = this.#state.cursor.next(this.#state.cursor.findDirectiveEnd(cursor));
				continue;
			}

			cursor = this.#parseMember(cursor, parent, unit, exported);
		}

		return null;
	}

	#packageEnd(endIndex: number): Readonly<{endIndex: number; nextIndex: number}> {
		let cursor = this.#state.cursor.next(endIndex);
		let last = endIndex;

		if (this.#state.cursor.identifier(cursor)) {
			last = cursor;
			cursor = this.#state.cursor.next(cursor);
		}

		if (this.#state.cursor.text(cursor) === ';') {
			last = cursor;
			cursor = this.#state.cursor.next(cursor);
		} else {
			warnAt(this.#state, ORACLE_DIAGNOSTIC.malformedDeclaration, 'Package END is missing a semicolon', cursor);
		}

		return {endIndex: last, nextIndex: cursor};
	}

	#parseMember(start: number, parent: number, unit: number, exported: boolean): number {
		const kind = this.#unitKind(start);

		if (kind === 'procedure' || kind === 'function') {
			return this.#parseRoutine({keyword: start, unitStart: start, parent, unit, exported, kind});
		}

		if (this.#state.cursor.word(start, 'PRAGMA')) {
			const end = this.#state.cursor.findDeclarationEnd(start);

			// A pragma names identifiers (an exception in `EXCEPTION_INIT`), so its
			// range must be scanned even though it declares nothing.
			collectReferences({state: this.#state, start, end, enclosing: parent, unit});

			return this.#state.cursor.next(end);
		}

		if (this.#state.cursor.word(start, 'TYPE')) {
			return parseTypeDeclaration({state: this.#state, start, parent, unit, exported});
		}

		if (this.#state.cursor.word(start, 'SUBTYPE')) {
			return parseSubtypeDeclaration({state: this.#state, start, parent, unit, exported});
		}

		if (this.#state.cursor.word(start, 'CURSOR')) {
			return parseCursorDeclaration({state: this.#state, start, parent, unit, exported});
		}

		return this.#state.cursor.identifier(start)
			? parseValueDeclaration({state: this.#state, start, parent, unit, exported})
			: recoverMember(this.#state, start);
	}

	#routineHeader(keyword: number): RoutineHeaderType | null {
		const name = this.#state.cursor.readQualifiedName(this.#state.cursor.next(keyword));

		if (name === null) {
			return null;
		}

		let cursor = name.nextIndex;
		const parameterList = this.#state.cursor.text(cursor) === '(' ? parseParameterList(this.#state, cursor) : null;

		if (parameterList !== null) {
			cursor = parameterList.nextIndex;
		}

		const signature = this.#signatureEnd(cursor);

		return signature === null ? null : {name, parameters: parameterList?.parameters ?? [], signature};
	}

	#declareRoutine(
		input: Readonly<{
			keyword: number;
			unitStart: number;
			parent: number | null;
			unit: number;
			exported: boolean;
			kind: 'procedure' | 'function';
		}>,
		header: RoutineHeaderType,
	): Readonly<{declarationIndex: number; unitIndex: number; declarationEnd: number | null}> {
		const {name} = header;
		const declarationIndex = this.#state.declarations.length;
		const unitIndex = input.unit < 0 ? this.#state.units.length : input.unit;
		const object = input.parent === null ? splitObjectName(name, this.#state.defaultSchema) : null;
		const unitKind = input.unit < 0 ? null : (this.#state.units[input.unit]?.kind ?? null);
		const form = routineFormOf(this.#state, {keyword: input.keyword, signature: header.signature, unitKind});
		const declarationEnd = form === 'call_spec' || form === 'polymorphic_table_function' ? this.#state.cursor.findDeclarationEnd(input.keyword) : null;

		this.#state.declarations.push({
			kind: input.kind,
			name: name.parts.at(-1) ?? namePartOf(''),
			range: rangeOf(this.#state, input.unitStart, declarationEnd ?? header.signature.index),
			nameRange: rangeOf(this.#state, name.endIndex, name.endIndex),
			parent: input.parent,
			unit: unitIndex,
			exported: input.exported,
			parameters: header.parameters,
			typeReferences: typeReferencesOf(this.#state, header.signature.start, header.signature.index),
			heading: normalizedPairingHeading(
				this.#state,
				input.keyword,
				header.signature.hasBody ? header.signature.index : this.#state.cursor.previous(header.signature.index),
			),
			form,
		});
		this.#state.definitionStarts.add(this.#state.cursor.token(name.endIndex)?.startOffset ?? -1);

		if (object !== null) {
			this.#state.units.push({
				kind: input.kind,
				schema: object.schema,
				name: object.object,
				canonical: `${object.schema.canonical}.${object.object.canonical}`,
				range: rangeOf(this.#state, input.unitStart, header.signature.index),
				nameRange: rangeOf(this.#state, name.endIndex, name.endIndex),
				declaration: declarationIndex,
			});
		}

		addParameters({state: this.#state, parameters: header.parameters, parent: declarationIndex, unit: unitIndex, exported: input.exported});
		collectReferences({state: this.#state, start: name.nextIndex, end: header.signature.index, enclosing: declarationIndex, unit: unitIndex});

		return {declarationIndex, unitIndex, declarationEnd};
	}

	#parseRoutine(
		input: Readonly<{
			keyword: number;
			unitStart: number;
			parent: number | null;
			unit: number;
			exported: boolean;
			kind: 'procedure' | 'function';
		}>,
	): number {
		const header = this.#routineHeader(input.keyword);

		if (header === null) {
			warnAt(this.#state, ORACLE_DIAGNOSTIC.parse, `Unable to read ${input.kind} declaration`, input.keyword);
			return recoverMember(this.#state, input.keyword);
		}

		const {declarationIndex, unitIndex, declarationEnd} = this.#declareRoutine(input, header);

		if (declarationEnd !== null) {
			return this.#state.cursor.next(declarationEnd);
		}

		if (!header.signature.hasBody) {
			this.#updateRange(declarationIndex, unitIndex, input.unitStart, header.signature.index);
			return this.#state.cursor.next(header.signature.index);
		}

		return this.#routineBody(header.signature.nextIndex, declarationIndex, unitIndex, input.unitStart);
	}

	#routineBody(start: number, declaration: number, unit: number, unitStart: number): number {
		let cursor = start;

		while (cursor < this.#state.cursor.length) {
			if (this.#state.cursor.word(cursor, 'BEGIN')) {
				const end = this.#state.cursor.findBlockEnd(cursor);

				this.#updateRange(declaration, unit, unitStart, statementEnd(end.nextIndex));
				parseNestedBlockDeclarations({
					state: this.#state,
					start: this.#state.cursor.next(cursor),
					end: end.endIndex,
					parent: declaration,
					unit,
					parseMember: (memberCursor, parent, memberUnit, exported) => this.#parseMember(memberCursor, parent, memberUnit, exported),
				});
				collectReferences({state: this.#state, start: this.#state.cursor.next(cursor), end: end.endIndex, enclosing: declaration, unit});
				return end.nextIndex;
			}

			if (this.#state.cursor.word(cursor, 'END')) {
				return recoverMember(this.#state, cursor);
			}

			if (this.#state.cursor.text(cursor) === ';' || this.#state.cursor.text(cursor) === 'DECLARE') {
				cursor = this.#state.cursor.next(cursor);
				continue;
			}

			if (this.#state.cursor.text(cursor).startsWith('$')) {
				cursor = this.#state.cursor.next(this.#state.cursor.findDirectiveEnd(cursor));
				continue;
			}

			cursor = this.#state.cursor.word(cursor, 'PRAGMA')
				? this.#state.cursor.next(this.#state.cursor.findDeclarationEnd(cursor))
				: this.#parseMember(cursor, declaration, unit, false);
		}

		return cursor;
	}

	#signatureEnd(start: number): Readonly<{index: number; nextIndex: number; start: number; hasBody: boolean}> | null {
		let depth = 0;

		for (let index = start; index < this.#state.cursor.length; index = this.#state.cursor.next(index)) {
			const text = this.#state.cursor.text(index);

			if (text === '(') {
				depth += 1;
			} else if (text === ')') {
				depth = Math.max(0, depth - 1);
			} else if (depth === 0 && (this.#state.cursor.word(index, 'IS') || this.#state.cursor.word(index, 'AS'))) {
				return {index: this.#state.cursor.previous(index), nextIndex: this.#state.cursor.next(index), start, hasBody: true};
			} else if (depth === 0 && text === ';') {
				return {index, nextIndex: this.#state.cursor.next(index), start, hasBody: false};
			}
		}

		return null;
	}

	#updateRange(declaration: number, unit: number, start: number, end: number): void {
		const existingDeclaration: OracleDeclarationType | undefined = this.#state.declarations[declaration];
		const existingUnit: OracleUnitType | undefined = this.#state.units[unit];

		if (existingDeclaration !== undefined) {
			this.#state.declarations[declaration] = {...existingDeclaration, range: rangeOf(this.#state, start, end)};
		}

		if (existingUnit?.declaration === declaration) {
			this.#state.units[unit] = {...existingUnit, range: rangeOf(this.#state, start, end)};
		}
	}

	#recoverUnit(start: number): number {
		for (let index = start; index < this.#state.cursor.length; index = this.#state.cursor.next(index)) {
			if (this.#state.cursor.text(index) === ';' || this.#state.cursor.isSlashBoundary(index)) {
				return this.#state.cursor.next(index);
			}
		}

		return this.#state.cursor.length;
	}
}

/**
 * Parses one Oracle source file with the supplied default schema.
 *
 * @param input - Tokens, workspace path, and manifest default schema.
 * @returns Structural parser facts.
 */
export const parseOracleDeclarations = (input: ParserInputType): OracleParseResultType => new OracleDeclarationParser(input).parseFile();
