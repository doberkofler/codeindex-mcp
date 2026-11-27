import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {type OracleNamePartType} from './name.ts';
import {type OracleDeclarationType, type OracleUnitType} from './syntax.ts';

type ColumnType = NonNullable<OracleDeclarationType['columnType']>;
type ColumnsType = Map<string, ColumnType | null>;

/** A null table entry means there is no unique CREATE TABLE definition. */
export type TableColumnsType = ReadonlyMap<string, ReadonlyMap<string, ColumnType | null> | null>;

const identifierOf = (name: OracleNamePartType): string => (name.quoted ? name.text.slice(1, -1).replaceAll('""', '"') : name.canonical);

const tableKeyOf = (schema: OracleNamePartType, table: OracleNamePartType): string => `${identifierOf(schema)}\u0000${identifierOf(table)}`;

export const buildTableColumns = (files: readonly OracleFileAnalysisType[]): TableColumnsType => {
	const tables = new Map<string, ColumnsType | null>();

	for (const file of files) {
		for (const [unitIndex, unit] of file.parse.units.entries()) {
			if (unit.createTable !== true) {
				continue;
			}

			const key = tableKeyOf(unit.schema, unit.name);

			if (tables.has(key)) {
				tables.set(key, null);
				continue;
			}

			const columns: ColumnsType = new Map();
			tables.set(key, columns);

			for (const index of file.graph.childrenByParent.get(unit.declaration) ?? []) {
				const column = file.parse.declarations[index];

				if (column?.kind === 'column' && column.unit === unitIndex) {
					const name = identifierOf(column.name);
					columns.set(name, columns.has(name) ? null : (column.columnType ?? null));
				}
			}
		}
	}

	return tables;
};

/**
 * Looks up a column in the schema that authored the anchor.
 *
 * @param tables - Indexed CREATE TABLE definitions in the project context.
 * @param unit - Unit that contains the anchor, for unqualified table names.
 * @param tableParts - Table name, optionally qualified by schema.
 * @param column - Authored column identifier.
 * @returns A supported scalar type when the definition is unambiguous.
 */
export const tableColumnTypeOf = (
	tables: TableColumnsType,
	unit: OracleUnitType | undefined,
	tableParts: readonly OracleNamePartType[],
	column: OracleNamePartType,
): ColumnType | undefined => {
	const table = tableParts.at(-1);
	const schema = tableParts.length === 1 ? unit?.schema : tableParts[0];

	if (table === undefined || schema === undefined || tableParts.length > 2) {
		return undefined;
	}

	return tables.get(tableKeyOf(schema, table))?.get(identifierOf(column)) ?? undefined;
};
