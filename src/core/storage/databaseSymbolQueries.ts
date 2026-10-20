import {placeholders, SYMBOL_COLUMNS} from './databaseRows.ts';

const symbolContextClause = (context: boolean): string =>
	context
		? ' and exists (select 1 from symbol_context sc where sc.generation_id = symbol.generation_id and sc.symbol_id = symbol.id and sc.context_name = ?)'
		: '';

/**
 * Builds the outline statement used by plan benchmarks.
 *
 * @param kindCount - Number of kind filter parameters.
 * @returns The statement text.
 */
export const outlineQuerySql = (kindCount: number): string =>
	`select ${SYMBOL_COLUMNS} from symbol where generation_id = ? and path = ?${kindCount > 0 ? ` and kind in (${placeholders(kindCount)})` : ''} order by start_offset, id limit ? offset ?`;

/**
 * Builds the symbol search statement used by plan benchmarks.
 *
 * @param context - Whether a context filter is present.
 * @returns The statement text.
 */
export const symbolSearchQuerySql = (context: boolean): string => {
	const contextClause = symbolContextClause(context);

	return `select ${SYMBOL_COLUMNS}, match_rank from (
				select ${SYMBOL_COLUMNS}, 0 as match_rank from symbol where generation_id = ? and qualified_name = ?${contextClause}
				union all
				select ${SYMBOL_COLUMNS}, 1 as match_rank from symbol where generation_id = ? and name = ? and qualified_name <> ?${contextClause}
				union all
				select ${SYMBOL_COLUMNS}, 2 as match_rank from symbol
				 where generation_id = ? and qualified_name >= ? and qualified_name < ? and qualified_name <> ? and name <> ?${contextClause}
				union all
				select ${SYMBOL_COLUMNS}, 3 as match_rank from symbol
				 where generation_id = ? and name >= ? and name < ? and name <> ? and qualified_name <> ?
				 and not (qualified_name >= ? and qualified_name < ?)${contextClause}
			 )
			 order by match_rank, qualified_name, path, start_line, start_column, id
			 limit ? offset ?`;
};

/**
 * Builds the reference statement used by plan benchmarks.
 *
 * @param role - Whether a role filter is present.
 * @param context - Whether a context filter is present.
 * @returns The statement text.
 */
export const referenceQuerySql = (role: boolean, context: boolean): string => {
	const roleClause = role ? ' and role = ?' : '';
	const contextClause = context
		? ` and exists (select 1 from occurrence_context oc
				where oc.generation_id = occurrence.generation_id and oc.symbol_id = occurrence.symbol_id
				and oc.path = occurrence.path and oc.start_offset = occurrence.start_offset and oc.role = occurrence.role
				and oc.context_name = ?)`
		: '';

	return `select path, start_offset, start_line, start_column, end_line, end_column, role, enclosing_id
			 from occurrence
			 where generation_id = ? and symbol_id = ?${roleClause}${contextClause}
			 order by path, start_offset, role
			 limit ? offset ?`;
};
