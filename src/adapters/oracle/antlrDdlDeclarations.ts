import {type Token} from 'antlr4ng';
import {nameInfoOfColumn, nameInfoOfIdentifier, nameRangeOf, rangeOf, topLevelStop} from './antlrDeclarationSupport.ts';
import {
	type Column_definitionContext,
	type Create_tableContext,
	type Create_viewContext,
	type Script_unitContext,
	type Sql_unitContext,
	type Virtual_column_definitionContext,
} from './generated/PlSqlParser.ts';
import {defaultSchemaName, namePartOf} from './name.ts';
import {type OracleDeclarationType, type OracleParseInputType, type OracleUnitType} from './syntax.ts';

type MutableFactsType = Readonly<{units: OracleUnitType[]; declarations: OracleDeclarationType[]}>;

const collectColumn = (
	input: Readonly<{
		source: OracleParseInputType;
		context: Column_definitionContext | Virtual_column_definitionContext;
		parent: number;
		unit: number;
		facts: MutableFactsType;
	}>,
): void => {
	const info = nameInfoOfColumn(input.context.column_name());

	input.facts.declarations.push({
		kind: 'column',
		name: info.name,
		range: rangeOf(input.source, input.context.start, input.context.stop),
		nameRange: nameRangeOf(input.source, info),
		parent: input.parent,
		unit: input.unit,
		exported: true,
		parameters: [],
		typeReferences: [],
	});
};

const collectTable = (input: OracleParseInputType, scriptUnit: Script_unitContext, context: Create_tableContext, facts: MutableFactsType): void => {
	const info = nameInfoOfIdentifier(context.table_name().identifier());
	const schema = namePartOf(context.schema_name()?.getText() ?? defaultSchemaName(input.defaultSchema));
	const range = rangeOf(input, context.start, topLevelStop(scriptUnit, context));
	const nameRange = nameRangeOf(input, info);
	const declarationIndex = facts.declarations.length;
	const unitIndex = facts.units.length;

	facts.declarations.push({
		kind: 'table',
		name: info.name,
		range,
		nameRange,
		parent: null,
		unit: unitIndex,
		exported: true,
		parameters: [],
		typeReferences: [],
	});
	facts.units.push({
		kind: 'table',
		schema,
		name: info.name,
		canonical: `${schema.canonical}.${info.name.canonical}`,
		range,
		nameRange,
		declaration: declarationIndex,
	});

	for (const property of context.relational_table()?.relational_property() ?? []) {
		const column = property.column_definition() ?? property.virtual_column_definition();

		if (column !== null) {
			collectColumn({source: input, context: column, parent: declarationIndex, unit: unitIndex, facts});
		}
	}
};

const collectView = (input: OracleParseInputType, scriptUnit: Script_unitContext, context: Create_viewContext, facts: MutableFactsType): void => {
	const identifier = context.id_expression(0);

	if (identifier === null) {
		return;
	}

	const info: Readonly<{name: ReturnType<typeof namePartOf>; token: Token | null}> = {name: namePartOf(identifier.getText()), token: identifier.start};
	const schema = namePartOf(context.schema_name()?.getText() ?? defaultSchemaName(input.defaultSchema));
	const range = rangeOf(input, context.start, topLevelStop(scriptUnit, context));
	const nameRange = nameRangeOf(input, info);
	const declarationIndex = facts.declarations.length;
	const unitIndex = facts.units.length;

	facts.declarations.push({
		kind: 'view',
		name: info.name,
		range,
		nameRange,
		parent: null,
		unit: unitIndex,
		exported: true,
		parameters: [],
		typeReferences: [],
	});
	facts.units.push({
		kind: 'view',
		schema,
		name: info.name,
		canonical: `${schema.canonical}.${info.name.canonical}`,
		range,
		nameRange,
		declaration: declarationIndex,
	});
};

/**
 * Collects one supported SQL DDL declaration from an ANTLR script unit.
 *
 * @param input - Source text and default schema.
 * @param scriptUnit - Top-level script unit that owns the declaration.
 * @param sqlUnit - Parsed SQL unit.
 * @param facts - Mutable serializable declaration facts.
 */
export const collectAntlrDdlDeclaration = (
	input: OracleParseInputType,
	scriptUnit: Script_unitContext,
	sqlUnit: Sql_unitContext,
	facts: MutableFactsType,
): void => {
	const table = sqlUnit.create_table();
	const view = sqlUnit.create_view();

	if (table !== null) {
		collectTable(input, scriptUnit, table, facts);
	} else if (view !== null) {
		collectView(input, scriptUnit, view, facts);
	}
};
