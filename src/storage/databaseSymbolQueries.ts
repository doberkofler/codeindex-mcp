import {type DatabaseSync} from 'node:sqlite';
import {type ReferenceType, type SymbolMatchType} from '../index/model.ts';
import {debugFor} from '../logging/debug.ts';
import {asNumber, SYMBOL_COLUMNS, toReference, toSymbolSummary} from './databaseRows.ts';

const debug = debugFor('database');

/**
 * Finds declarations by exact and prefix name matches.
 *
 * @param reader - Reader connection.
 * @param input - Generation, query, and page bounds.
 * @returns Ranked symbol matches.
 */
export const findSymbols = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; query: string; limit: number; offset: number}>,
): readonly SymbolMatchType[] => {
	const {generationId, query, limit, offset} = input;
	const upper = `${query}\uFFFF`;
	const columns = SYMBOL_COLUMNS;
	const rows = reader
		.prepare(
			`select ${columns}, match_rank from (
				select ${columns}, 0 as match_rank from symbol where generation_id = ? and qualified_name = ?
				union all
				select ${columns}, 1 as match_rank from symbol where generation_id = ? and name = ? and qualified_name <> ?
				union all
				select ${columns}, 2 as match_rank from symbol
				 where generation_id = ? and qualified_name >= ? and qualified_name < ? and qualified_name <> ? and name <> ?
				union all
				select ${columns}, 3 as match_rank from symbol
				 where generation_id = ? and name >= ? and name < ? and name <> ? and qualified_name <> ?
				 and not (qualified_name >= ? and qualified_name < ?)
			 )
			 order by match_rank, qualified_name, path, start_line, start_column, id
			 limit ? offset ?`,
		)
		.all(
			generationId,
			query,
			generationId,
			query,
			query,
			generationId,
			query,
			upper,
			query,
			query,
			generationId,
			query,
			upper,
			query,
			query,
			query,
			upper,
			limit,
			offset,
		);

	const matches: readonly SymbolMatchType['match'][] = ['exact_qualified', 'exact_name', 'prefix_qualified', 'prefix_name'];
	debug('find symbols', {generationId, query, limit, offset, rows: rows.length});

	return rows.map((row) => {
		const matchIndex = asNumber(row, 'match_rank');
		const match = matches[matchIndex] ?? 'prefix_name';
		return {...toSymbolSummary(row), match};
	});
};

/**
 * Finds stored definition and reference occurrences for one symbol.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, optional role, and page bounds.
 * @returns Occurrences in path order.
 */
export const findReferences = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; symbolId: string; role: 'definition' | 'reference' | undefined; limit: number; offset: number}>,
): readonly ReferenceType[] => {
	const roleClause = input.role === undefined ? '' : ' and role = ?';
	const parameters: (string | number)[] = [input.generationId, input.symbolId];

	if (input.role !== undefined) {
		parameters.push(input.role);
	}

	parameters.push(input.limit, input.offset);

	const rows = reader
		.prepare(
			`select path, start_line, start_column, end_line, end_column, role, enclosing_id
			 from occurrence
			 where generation_id = ? and symbol_id = ?${roleClause}
			 order by path, start_offset, role
			 limit ? offset ?`,
		)
		.all(...parameters);
	debug('find references', {
		generationId: input.generationId,
		symbolId: input.symbolId,
		role: input.role ?? null,
		limit: input.limit,
		offset: input.offset,
		rows: rows.length,
	});

	return rows.map((row) => toReference(row));
};
