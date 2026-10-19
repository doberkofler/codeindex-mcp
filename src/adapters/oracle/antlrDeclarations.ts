import {type ParserRuleContext} from 'antlr4ng';
import {
	BlockContext,
	Create_packageContext,
	Function_bodyContext,
	Function_specContext,
	PlSqlParser,
	type BodyContext,
	type Create_function_bodyContext,
	type Create_package_bodyContext,
	type Create_procedure_bodyContext,
	type Cursor_declarationContext,
	type Exception_declarationContext,
	type Field_specContext,
	type Package_obj_bodyContext,
	type Package_obj_specContext,
	type Procedure_bodyContext,
	type Procedure_specContext,
	type Script_unitContext,
	type Seq_of_declare_specsContext,
	type Sql_scriptContext,
	type Subtype_declarationContext,
	type Type_declarationContext,
	type Variable_declarationContext,
} from './generated/PlSqlParser.ts';
import {
	nameInfoOfColumn,
	nameInfoOfIdentifier,
	nameInfoOfRoutineName,
	nameRangeOf,
	parametersOf,
	parameterSpecsOf,
	rangeOf,
	topLevelStop,
	typeReferencesOf,
} from './antlrDeclarationSupport.ts';
import {loopIteratorDeclarationOf, nestedDeclarationContexts} from './antlrNestedScopes.ts';
import {defaultSchemaName, namePartOf, type OracleNamePartType} from './name.ts';
import {type OracleDeclarationType, type OracleParameterType, type OracleParseInputType, type OracleRangeType, type OracleUnitType} from './syntax.ts';

type ScopeType = Readonly<{parent: number; unit: number; exported: boolean}>;
type RoutineScopeType = Readonly<{parent: number | null; unit: number; exported: boolean}>;
type MemberContextType = Readonly<{
	pragma_declaration: () => unknown;
	exception_declaration: () => Exception_declarationContext | null;
	procedure_spec: () => Procedure_specContext | null;
	function_spec: () => Function_specContext | null;
	variable_declaration: () => Variable_declarationContext | null;
	subtype_declaration: () => Subtype_declarationContext | null;
	cursor_declaration: () => Cursor_declarationContext | null;
	type_declaration: () => Type_declarationContext | null;
	procedure_body?: () => Procedure_bodyContext | null;
	function_body?: () => Function_bodyContext | null;
}>;

type RoutineInputType = Readonly<{
	kind: 'procedure' | 'function';
	name: OracleNamePartType;
	range: OracleRangeType;
	nameRange: OracleRangeType;
	parameters: readonly OracleParameterType[];
	declareSpecs: Seq_of_declare_specsContext | null;
	body: BodyContext | null;
	typeReferences: OracleDeclarationType['typeReferences'];
	scope: RoutineScopeType;
}>;

class OracleDeclarationCollector {
	readonly #input: OracleParseInputType;
	readonly #units: OracleUnitType[] = [];
	readonly #declarations: OracleDeclarationType[] = [];

	public constructor(input: OracleParseInputType) {
		this.#input = input;
	}

	public get units(): readonly OracleUnitType[] {
		return this.#units;
	}

	public get declarations(): readonly OracleDeclarationType[] {
		return this.#declarations;
	}

	public collect(script: Sql_scriptContext): void {
		for (const scriptUnit of script.script_unit()) {
			this.#collectScriptUnit(scriptUnit);
		}
	}

	#addDeclaration(declaration: OracleDeclarationType): number {
		this.#declarations.push(declaration);

		return this.#declarations.length - 1;
	}

	#addParameterDeclarations(parameters: readonly OracleParameterType[], scope: ScopeType): void {
		for (const parameter of parameters) {
			this.#addDeclaration({
				kind: 'parameter',
				name: parameter.name,
				range: parameter.range,
				nameRange: parameter.nameRange,
				parent: scope.parent,
				unit: scope.unit,
				exported: scope.exported,
				parameters: [],
				typeReferences: parameter.typeReferences,
			});
		}
	}

	#collectField(context: Field_specContext, scope: ScopeType): void {
		const info = nameInfoOfColumn(context.column_name());

		this.#addDeclaration({
			kind: 'field',
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parent: scope.parent,
			unit: scope.unit,
			exported: scope.exported,
			parameters: [],
			typeReferences: typeReferencesOf(this.#input, context.type_spec()),
		});
	}

	#collectVariable(context: Variable_declarationContext, scope: ScopeType): void {
		const info = nameInfoOfIdentifier(context.identifier());

		this.#addDeclaration({
			kind: context.getToken(PlSqlParser.CONSTANT, 0) === null ? 'variable' : 'constant',
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parent: scope.parent,
			unit: scope.unit,
			exported: scope.exported,
			parameters: [],
			typeReferences: typeReferencesOf(this.#input, context.type_spec()),
		});
	}

	#collectSubtype(context: Subtype_declarationContext, scope: ScopeType): void {
		const info = nameInfoOfIdentifier(context.identifier());

		this.#addDeclaration({
			kind: 'subtype',
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parent: scope.parent,
			unit: scope.unit,
			exported: scope.exported,
			parameters: [],
			typeReferences: typeReferencesOf(this.#input, context.type_spec()),
		});
	}

	#collectException(context: Exception_declarationContext, scope: ScopeType): void {
		const info = nameInfoOfIdentifier(context.identifier());

		this.#addDeclaration({
			kind: 'exception',
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parent: scope.parent,
			unit: scope.unit,
			exported: scope.exported,
			parameters: [],
			typeReferences: [],
		});
	}

	#collectCursor(context: Cursor_declarationContext, scope: ScopeType): void {
		const info = nameInfoOfIdentifier(context.identifier());
		const parameters = parameterSpecsOf(this.#input, context.parameter_spec());
		const index = this.#addDeclaration({
			kind: 'cursor',
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parent: scope.parent,
			unit: scope.unit,
			exported: scope.exported,
			parameters,
			typeReferences: typeReferencesOf(this.#input, context.type_spec()),
		});

		this.#addParameterDeclarations(parameters, {parent: index, unit: scope.unit, exported: scope.exported});
	}

	#collectType(context: Type_declarationContext, scope: ScopeType): void {
		const record = context.record_type_def();
		const collection = context.table_type_def() ?? context.varray_type_def();
		const refCursor = context.ref_cursor_type_def();
		const kind = record !== null ? 'record_type' : collection !== null ? 'collection_type' : refCursor !== null ? 'cursor' : null;

		if (kind === null) {
			return;
		}

		const typeSpec = context.table_type_def()?.type_spec() ?? context.varray_type_def()?.type_spec() ?? refCursor?.type_spec() ?? null;
		const info = nameInfoOfIdentifier(context.identifier());
		const index = this.#addDeclaration({
			kind,
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parent: scope.parent,
			unit: scope.unit,
			exported: scope.exported,
			parameters: [],
			typeReferences: typeReferencesOf(this.#input, typeSpec),
		});

		if (record !== null) {
			for (const field of record.field_spec()) {
				this.#collectField(field, {parent: index, unit: scope.unit, exported: scope.exported});
			}
		}
	}

	#addRoutine(input: RoutineInputType): number {
		const index = this.#addDeclaration({
			kind: input.kind,
			name: input.name,
			range: input.range,
			nameRange: input.nameRange,
			parent: input.scope.parent,
			unit: input.scope.unit,
			exported: input.scope.exported,
			parameters: input.parameters,
			typeReferences: input.typeReferences,
		});

		this.#addParameterDeclarations(input.parameters, {parent: index, unit: input.scope.unit, exported: input.scope.exported});

		if (input.declareSpecs !== null) {
			for (const spec of input.declareSpecs.declare_spec()) {
				this.#collectMember(spec, index, input.scope.unit, false);
			}
		}

		if (input.body !== null) {
			this.#collectNestedDeclarations(input.body, index, input.scope.unit, false);
		}

		return index;
	}

	#collectNestedDeclarations(root: ParserRuleContext, parent: number, unit: number, exported: boolean): void {
		for (const context of nestedDeclarationContexts(root)) {
			if (context instanceof BlockContext) {
				for (const spec of context.declare_spec()) {
					this.#collectMember(spec, parent, unit, exported);
				}
			} else {
				const declaration = loopIteratorDeclarationOf({source: this.#input, loop: context, parent, unit, exported});

				if (declaration !== null) {
					this.#addDeclaration(declaration);
				}
			}
		}
	}

	#collectRoutineSpec(context: Procedure_specContext | Function_specContext, kind: 'procedure' | 'function', scope: RoutineScopeType): void {
		const info = nameInfoOfIdentifier(context.identifier());
		const typeReferences = context instanceof Function_specContext ? typeReferencesOf(this.#input, context.type_spec()) : [];

		this.#addRoutine({
			kind,
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parameters: parametersOf(this.#input, context.parameter()),
			declareSpecs: null,
			body: null,
			typeReferences,
			scope,
		});
	}

	#collectRoutineBody(context: Procedure_bodyContext | Function_bodyContext, kind: 'procedure' | 'function', scope: RoutineScopeType): void {
		const info = nameInfoOfIdentifier(context.identifier());
		const typeReferences = context instanceof Function_bodyContext ? typeReferencesOf(this.#input, context.type_spec()) : [];

		this.#addRoutine({
			kind,
			name: info.name,
			range: rangeOf(this.#input, context.start, context.stop),
			nameRange: nameRangeOf(this.#input, info),
			parameters: parametersOf(this.#input, context.parameter()),
			declareSpecs: context.seq_of_declare_specs(),
			body: context.body(),
			typeReferences,
			scope,
		});
	}

	#collectMember(member: MemberContextType, parent: number, unit: number, exported: boolean): void {
		const scope: ScopeType = {parent, unit, exported};

		if (member.pragma_declaration() !== null) {
			return;
		}

		const exception = member.exception_declaration();
		const procedure = member.procedure_spec();
		const functionSpec = member.function_spec();
		const procedureBody = member.procedure_body?.() ?? null;
		const functionBody = member.function_body?.() ?? null;
		const variable = member.variable_declaration();
		const subtype = member.subtype_declaration();
		const cursor = member.cursor_declaration();
		const type = member.type_declaration();

		if (exception !== null) {
			this.#collectException(exception, scope);
		} else if (procedure !== null) {
			this.#collectRoutineSpec(procedure, 'procedure', scope);
		} else if (functionSpec !== null) {
			this.#collectRoutineSpec(functionSpec, 'function', scope);
		} else if (procedureBody !== null) {
			this.#collectRoutineBody(procedureBody, 'procedure', scope);
		} else if (functionBody !== null) {
			this.#collectRoutineBody(functionBody, 'function', scope);
		} else if (variable !== null) {
			this.#collectVariable(variable, scope);
		} else if (subtype !== null) {
			this.#collectSubtype(subtype, scope);
		} else if (cursor !== null) {
			this.#collectCursor(cursor, scope);
		} else if (type !== null) {
			this.#collectType(type, scope);
		}
	}

	#collectPackage(scriptUnit: Script_unitContext, context: Create_packageContext | Create_package_bodyContext, kind: 'package-spec' | 'package-body'): void {
		const name = context.package_name(0)?.identifier();

		if (name === undefined) {
			return;
		}

		const info = nameInfoOfIdentifier(name);
		const schema = namePartOf(context.schema_object_name()?.getText() ?? defaultSchemaName(this.#input.defaultSchema));
		const range = rangeOf(this.#input, context.start, topLevelStop(scriptUnit, context));
		const nameRange = nameRangeOf(this.#input, info);
		const declarationIndex = this.#declarations.length;
		const unitIndex = this.#units.length;

		this.#declarations.push({
			kind: 'package',
			name: info.name,
			range,
			nameRange,
			parent: null,
			unit: unitIndex,
			exported: kind === 'package-spec',
			parameters: [],
			typeReferences: [],
		});
		this.#units.push({
			kind,
			schema,
			name: info.name,
			canonical: `${schema.canonical}.${info.name.canonical}`,
			range,
			nameRange,
			declaration: declarationIndex,
		});

		const members: readonly (Package_obj_specContext | Package_obj_bodyContext)[] =
			context instanceof Create_packageContext ? context.package_obj_spec() : context.package_obj_body();

		for (const member of members) {
			this.#collectMember(member, declarationIndex, unitIndex, kind === 'package-spec');
		}

		const initialization = context instanceof Create_packageContext ? null : context.seq_of_statements();

		if (initialization !== null) {
			this.#collectNestedDeclarations(initialization, declarationIndex, unitIndex, false);
		}
	}

	#collectProcedure(scriptUnit: Script_unitContext, context: Create_procedure_bodyContext): void {
		const name = context.procedure_name();
		const identifier = name.identifier();
		const member = name.id_expression();
		const info = nameInfoOfRoutineName(name);
		const schema = member === null ? namePartOf(defaultSchemaName(this.#input.defaultSchema)) : namePartOf(identifier.getText());
		const range = rangeOf(this.#input, context.start, topLevelStop(scriptUnit, context));
		const nameRange = nameRangeOf(this.#input, info);
		const unitIndex = this.#units.length;
		const declarationIndex = this.#declarations.length;

		this.#units.push({
			kind: 'procedure',
			schema,
			name: info.name,
			canonical: `${schema.canonical}.${info.name.canonical}`,
			range,
			nameRange,
			declaration: declarationIndex,
		});
		this.#addRoutine({
			kind: 'procedure',
			name: info.name,
			range,
			nameRange,
			parameters: parametersOf(this.#input, context.parameter()),
			declareSpecs: context.seq_of_declare_specs(),
			body: context.body(),
			typeReferences: [],
			scope: {parent: null, unit: unitIndex, exported: true},
		});
	}

	#collectFunction(scriptUnit: Script_unitContext, context: Create_function_bodyContext): void {
		const name = context.function_name();
		const identifier = name.identifier();
		const member = name.id_expression();
		const info = nameInfoOfRoutineName(name);
		const schema = member === null ? namePartOf(defaultSchemaName(this.#input.defaultSchema)) : namePartOf(identifier.getText());
		const range = rangeOf(this.#input, context.start, topLevelStop(scriptUnit, context));
		const nameRange = nameRangeOf(this.#input, info);
		const unitIndex = this.#units.length;
		const declarationIndex = this.#declarations.length;

		this.#units.push({
			kind: 'function',
			schema,
			name: info.name,
			canonical: `${schema.canonical}.${info.name.canonical}`,
			range,
			nameRange,
			declaration: declarationIndex,
		});
		this.#addRoutine({
			kind: 'function',
			name: info.name,
			range,
			nameRange,
			parameters: parametersOf(this.#input, context.parameter()),
			declareSpecs: context.seq_of_declare_specs(),
			body: context.body(),
			typeReferences: typeReferencesOf(this.#input, context.type_spec()),
			scope: {parent: null, unit: unitIndex, exported: true},
		});
	}

	#collectScriptUnit(scriptUnit: Script_unitContext): void {
		const unit = scriptUnit.plsql_unit();

		if (unit === null) {
			return;
		}

		const packageSpec = unit.create_package();
		const packageBody = unit.create_package_body();
		const procedure = unit.create_procedure_body();
		const functionBody = unit.create_function_body();

		if (packageSpec !== null) {
			this.#collectPackage(scriptUnit, packageSpec, 'package-spec');
		} else if (packageBody !== null) {
			this.#collectPackage(scriptUnit, packageBody, 'package-body');
		} else if (procedure !== null) {
			this.#collectProcedure(scriptUnit, procedure);
		} else if (functionBody !== null) {
			this.#collectFunction(scriptUnit, functionBody);
		}
	}
}

/**
 * Converts one ANTLR parse tree into serializable Oracle declaration facts.
 *
 * The traversal preserves source order, lexical parents, unit ownership,
 * package specification/body export rules, overload identity, and exact
 * declaration ranges. ANTLR objects do not leave this module.
 *
 * @param input - Source text, workspace-relative path, and default schema.
 * @param script - Parsed SQL script root.
 * @returns Units and declarations in source order.
 */
export const collectAntlrDeclarations = (
	input: OracleParseInputType,
	script: Sql_scriptContext,
): Readonly<{units: readonly OracleUnitType[]; declarations: readonly OracleDeclarationType[]}> => {
	const collector = new OracleDeclarationCollector(input);
	collector.collect(script);

	return {units: collector.units, declarations: collector.declarations};
};
