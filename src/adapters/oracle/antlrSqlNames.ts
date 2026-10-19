import {
	type Column_aliasContext,
	type IdentifierContext,
	type Query_nameContext,
	type Sql_scriptContext,
	type Table_aliasContext,
	type Tableview_nameContext,
} from './generated/PlSqlParser.ts';
import {PlSqlParserVisitor} from './generated/PlSqlParserVisitor.ts';
import {namePartOf} from './name.ts';

const nameOfIdentifier = (identifier: IdentifierContext | null): string | null =>
	identifier === null ? null : namePartOf(identifier.id_expression().getText()).canonical;

const tableNameOf = (context: Tableview_nameContext): string | null => {
	const expression = context.id_expression();

	return expression === null ? nameOfIdentifier(context.identifier()) : namePartOf(expression.getText()).canonical;
};

/**
 * Collects SQL table names, aliases, and query names for dependency filtering.
 *
 * These names qualify columns and correlated references, not packages. Keeping
 * them separate lets dependency derivation exclude table, view, and column
 * chains before the project-level package lookup runs.
 */
class OracleSqlNameCollector extends PlSqlParserVisitor<void> {
	readonly #names = new Set<string>();

	public collect(script: Sql_scriptContext): ReadonlySet<string> {
		this.visit(script);

		return this.#names;
	}

	public override visitTableview_name = (context: Tableview_nameContext): void => {
		const name = tableNameOf(context);

		if (name !== null) {
			this.#names.add(name);
		}

		this.visitChildren(context);
	};

	public override visitTable_alias = (context: Table_aliasContext): void => {
		const name = nameOfIdentifier(context.identifier());

		if (name !== null) {
			this.#names.add(name);
		}
	};

	public override visitColumn_alias = (context: Column_aliasContext): void => {
		const name = nameOfIdentifier(context.identifier());

		if (name !== null) {
			this.#names.add(name);
		}
	};

	public override visitQuery_name = (context: Query_nameContext): void => {
		this.#names.add(namePartOf(context.identifier().id_expression().getText()).canonical);
	};
}

/**
 * Returns SQL-only qualifier names from one parse tree.
 *
 * @param script - Parsed SQL script root.
 * @returns Canonical table, table-alias, column-alias, and query names.
 */
export const collectAntlrSqlNames = (script: Sql_scriptContext): ReadonlySet<string> => new OracleSqlNameCollector().collect(script);
