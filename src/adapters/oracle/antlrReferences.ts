import {
	type Call_statementContext,
	type Exception_nameContext,
	type Function_argumentContext,
	type General_elementContext,
	type General_element_partContext,
	type Id_expressionContext,
	PlSqlParser,
	type Routine_nameContext,
	type Sql_scriptContext,
	type Table_elementContext,
	type Type_specContext,
	type Variable_nameContext,
} from './generated/PlSqlParser.ts';
import {PlSqlParserVisitor} from './generated/PlSqlParserVisitor.ts';
import {generalElementParts, rangeOf} from './antlrDeclarationSupport.ts';
import {namePartOf, oracleNameOf, type OracleNamePartType} from './name.ts';
import {type OracleDeclarationType, type OracleParseInputType, type OracleReferenceSiteType} from './syntax.ts';

type ElementPartType = Readonly<{
	id: Id_expressionContext;
	name: OracleNamePartType;
	nameRange: ReturnType<typeof rangeOf>;
	arguments: readonly Function_argumentContext[];
}>;

type MutableSiteType = Omit<OracleReferenceSiteType, 'unit' | 'enclosing'>;

type AddSiteInputType = Readonly<{
	parts: readonly ElementPartType[];
	kind: OracleReferenceSiteType['kind'];
	call: boolean;
	argument: Function_argumentContext | null;
	rowType: boolean;
	endToken?: Parameters<typeof rangeOf>[2];
}>;

type DeclarationRangeType = Readonly<{
	index: number;
	declaration: OracleDeclarationType;
	start: number;
	end: number;
	length: number;
}>;

const argumentNamesOf = (argument: Function_argumentContext | null): readonly string[] =>
	argument === null
		? []
		: argument.argument().flatMap((item) => {
				const identifier = item.identifier();

				return identifier === null ? [] : [namePartOf(identifier.id_expression().getText()).canonical];
			});

const idExpressionsOf = (
	context: Routine_nameContext | Exception_nameContext | Table_elementContext | Variable_nameContext,
): readonly Id_expressionContext[] => {
	if ('identifier' in context) {
		return [context.identifier().id_expression(), ...context.id_expression()];
	}

	return context.id_expression();
};

/**
 * Collects statically useful reference sites from one ANTLR parse tree.
 *
 * The collector never emits declaration names, labels, aliases, SQL object
 * names, named-argument labels, or package qualifiers as separate sites. Each
 * site is later bound to its nearest lexical declaration; unresolved names are
 * dropped by the resolver.
 */
class OracleReferenceCollector extends PlSqlParserVisitor<void> {
	readonly #input: OracleParseInputType;
	readonly #sites: MutableSiteType[] = [];

	public constructor(input: OracleParseInputType) {
		super();
		this.#input = input;
	}

	public get sites(): readonly MutableSiteType[] {
		return this.#sites;
	}

	public override visitGeneral_element = (context: General_elementContext): void => {
		const parts = generalElementParts(context).map((part) => this.#elementPart(part));

		if (parts.length === 0) {
			return;
		}

		for (const [index, part] of parts.entries()) {
			if (part.arguments.length === 0) {
				continue;
			}

			this.#add({
				parts: parts.slice(0, index + 1),
				kind: 'call',
				call: true,
				argument: part.arguments[0] ?? null,
				rowType: false,
			});

			for (const argument of part.arguments) {
				this.visit(argument);
			}
		}

		if (parts.at(-1)?.arguments.length === 0) {
			this.#add({parts, kind: 'reference', call: false, argument: null, rowType: false});
		}
	};

	public override visitType_spec = (context: Type_specContext): void => {
		const typeName = context.type_name();

		if (typeName !== null) {
			const parts = typeName.id_expression().map((id) => this.#idPart(id));
			const anchored = context.getToken(PlSqlParser.PERCENT_ROWTYPE, 0) !== null || context.getToken(PlSqlParser.PERCENT_TYPE, 0) !== null;

			if (parts.length > 0) {
				this.#add({
					parts,
					kind: anchored ? 'type-anchor' : 'reference',
					call: false,
					argument: null,
					rowType: context.getToken(PlSqlParser.PERCENT_ROWTYPE, 0) !== null,
					endToken: anchored ? context.stop : typeName.stop,
				});
			}
		}

		this.visitChildren(context);
	};

	public override visitCall_statement = (context: Call_statementContext): void => {
		const names = context.routine_name();
		const callArguments = context.function_argument();

		for (const [index, name] of names.entries()) {
			const parts = idExpressionsOf(name).map((id) => this.#idPart(id));

			if (parts.length > 0) {
				this.#add({parts, kind: 'call', call: true, argument: callArguments[index] ?? null, rowType: false});
			}
		}

		this.visitChildren(context);
	};

	public override visitException_name = (context: Exception_nameContext): void => {
		this.#addSimple(context);
	};

	public override visitVariable_name = (context: Variable_nameContext): void => {
		this.#addSimple(context);
	};

	public override visitTable_element = (context: Table_elementContext): void => {
		this.#addSimple(context);
	};

	#idPart(id: Id_expressionContext): ElementPartType {
		return {id, name: namePartOf(id.getText()), nameRange: rangeOf(this.#input, id.start, id.stop), arguments: []};
	}

	#elementPart(context: General_element_partContext): ElementPartType {
		const id = context.id_expression();

		return {...this.#idPart(id), arguments: context.function_argument()};
	}

	#add(site: AddSiteInputType): void {
		const [first] = site.parts;
		const last = site.parts.at(-1);

		if (first === undefined || last === undefined) {
			throw new Error('A reference site requires at least one name part');
		}

		this.#sites.push({
			name: oracleNameOf({parts: site.parts.map((part) => part.name)}),
			range: rangeOf(this.#input, first.id.start, site.endToken ?? last.id.stop),
			nameRange: last.nameRange,
			kind: site.kind,
			argumentCount: site.call ? (site.argument?.argument().length ?? 0) : null,
			argumentNames: argumentNamesOf(site.argument),
			rowType: site.rowType,
		});
	}

	#addSimple(context: Routine_nameContext | Exception_nameContext | Table_elementContext | Variable_nameContext): void {
		const parts = idExpressionsOf(context).map((id) => this.#idPart(id));

		if (parts.length > 0) {
			this.#add({parts, kind: 'reference', call: false, argument: null, rowType: false});
		}
	}
}

const rangeIndexOf = (declarations: readonly OracleDeclarationType[]): readonly DeclarationRangeType[] =>
	declarations
		.map((declaration, index) => ({
			index,
			declaration,
			start: declaration.range.startOffset,
			end: declaration.range.endOffset,
			length: declaration.range.endOffset - declaration.range.startOffset,
		}))
		.sort((left, right) => left.start - right.start || left.length - right.length);

const addStartingAt = (ranges: readonly DeclarationRangeType[], cursor: number, active: DeclarationRangeType[], offset: number): number => {
	let index = cursor;

	while (index < ranges.length && (ranges[index]?.start ?? Number.POSITIVE_INFINITY) <= offset) {
		const range = ranges[index];

		if (range !== undefined) {
			active.push(range);
		}

		index += 1;
	}

	return index;
};

const removeEndingBefore = (active: DeclarationRangeType[], offset: number): void => {
	for (let index = active.length - 1; index >= 0; index -= 1) {
		if ((active[index]?.end ?? -1) < offset) {
			active.splice(index, 1);
		}
	}
};

const bestContaining = (active: readonly DeclarationRangeType[], offset: number): DeclarationRangeType | null => {
	let best: DeclarationRangeType | null = null;

	for (const range of active) {
		if (range.start > offset || range.end < offset) {
			continue;
		}

		if (best === null || range.length < best.length || (range.length === best.length && range.start > best.start)) {
			best = range;
		}
	}

	return best;
};

const assignEnclosing = (declarations: readonly OracleDeclarationType[], sites: readonly MutableSiteType[]): readonly OracleReferenceSiteType[] => {
	const ranges = rangeIndexOf(declarations);
	const ordered = [...sites].sort(
		(left, right) =>
			left.nameRange.startOffset - right.nameRange.startOffset ||
			left.range.startOffset - right.range.startOffset ||
			left.name.canonical.localeCompare(right.name.canonical),
	);
	const active: DeclarationRangeType[] = [];
	const result: OracleReferenceSiteType[] = [];
	let cursor = 0;

	for (const site of ordered) {
		const offset = site.nameRange.startOffset;

		cursor = addStartingAt(ranges, cursor, active, offset);
		removeEndingBefore(active, offset);
		const best = bestContaining(active, offset);

		if (best !== null) {
			result.push({...site, unit: best.declaration.unit, enclosing: best.index});
		}
	}

	return result.sort(
		(left, right) =>
			left.range.startOffset - right.range.startOffset ||
			left.nameRange.startOffset - right.nameRange.startOffset ||
			left.name.canonical.localeCompare(right.name.canonical),
	);
};

/**
 * Converts one ANTLR parse tree into reference sites.
 *
 * Declaration names remain definition facts. A site is emitted only for an
 * authored name occurrence; binding to a symbol happens in the shared resolver.
 *
 * @param input - Source text, workspace path, and default schema.
 * @param script - Parsed SQL script root.
 * @param declarations - Declarations collected from the same parse tree.
 * @returns Reference sites with lexical enclosing declaration indexes.
 */
export const collectAntlrReferences = (
	input: OracleParseInputType,
	script: Sql_scriptContext,
	declarations: readonly OracleDeclarationType[],
): readonly OracleReferenceSiteType[] => {
	const collector = new OracleReferenceCollector(input);

	collector.visit(script);

	return assignEnclosing(declarations, collector.sites);
};
