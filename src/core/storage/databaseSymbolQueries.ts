import {type DatabaseSync} from 'node:sqlite';
import {type ReferenceType, type SymbolMatchType} from '../model.ts';
import {debugFor} from '../logging/debug.ts';
import {asNumber, asString, placeholders, SYMBOL_COLUMNS, toReference, toSymbolSummary} from './databaseRows.ts';
import {listOccurrenceContexts, listSymbolContexts, occurrenceContextKey} from './databaseContextQueries.ts';

const debug = debugFor('database');

const symbolContextClause = (context: boolean): string =>
	context
		? ' and exists (select 1 from symbol_context sc where sc.generation_id = symbol.generation_id and sc.symbol_id = symbol.id and sc.context_name = ?)'
		: '';

/**
 * Builds the outline statement used by the hot page path.
 *
 * Exported so benchmarks and plan tests explain the production statement
 * rather than a hand-maintained copy.
 *
 * @param kindCount - Number of kind filter parameters.
 * @returns The statement text.
 */
export const outlineQuerySql = (kindCount: number): string =>
	`select ${SYMBOL_COLUMNS} from symbol where generation_id = ? and path = ?${kindCount > 0 ? ` and kind in (${placeholders(kindCount)})` : ''} order by start_offset, id limit ? offset ?`;

/**
 * Builds the symbol search statement used by the hot page path.
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
 * Builds the reference statement used by the hot page path.
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

/**
 * Finds declarations by exact and prefix name matches.
 *
 * @param reader - Reader connection.
 * @param input - Generation, query, and page bounds.
 * @returns Ranked symbol matches.
 */
export const findSymbols = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; query: string; context?: string | undefined; limit: number; offset: number}>,
): readonly SymbolMatchType[] => {
	const {generationId, query, limit, offset} = input;
	const upper = `${query}\uFFFF`;
	const contextParameters = input.context === undefined ? [] : [input.context];
	const rows = reader
		.prepare(symbolSearchQuerySql(input.context !== undefined))
		.all(
			generationId,
			query,
			...contextParameters,
			generationId,
			query,
			query,
			...contextParameters,
			generationId,
			query,
			upper,
			query,
			query,
			...contextParameters,
			generationId,
			query,
			upper,
			query,
			query,
			query,
			upper,
			...contextParameters,
			limit,
			offset,
		);

	const matches: readonly SymbolMatchType['match'][] = ['exact_qualified', 'exact_name', 'prefix_qualified', 'prefix_name'];
	const contexts = listSymbolContexts(
		reader,
		generationId,
		rows.map((row) => asString(row, 'id')),
	);
	debug('find symbols', {generationId, query, context: input.context ?? null, limit, offset, rows: rows.length});

	return rows.map((row) => {
		const matchIndex = asNumber(row, 'match_rank');
		const match = matches[matchIndex] ?? 'prefix_name';
		const id = asString(row, 'id');

		return {...toSymbolSummary(row, contexts.get(id) ?? []), match};
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
	input: Readonly<{
		generationId: string;
		symbolId: string;
		role: 'definition' | 'reference' | undefined;
		context?: string | undefined;
		limit: number;
		offset: number;
	}>,
): readonly ReferenceType[] => {
	const parameters: (string | number)[] = [input.generationId, input.symbolId];

	if (input.role !== undefined) {
		parameters.push(input.role);
	}

	if (input.context !== undefined) {
		parameters.push(input.context);
	}

	parameters.push(input.limit, input.offset);

	const rows = reader.prepare(referenceQuerySql(input.role !== undefined, input.context !== undefined)).all(...parameters);
	const contexts = listOccurrenceContexts(reader, {
		generationId: input.generationId,
		symbolId: input.symbolId,
		...(input.context === undefined ? {} : {context: input.context}),
	});
	debug('find references', {
		generationId: input.generationId,
		symbolId: input.symbolId,
		role: input.role ?? null,
		context: input.context ?? null,
		limit: input.limit,
		offset: input.offset,
		rows: rows.length,
	});

	return rows.map((row) => {
		const path = asString(row, 'path');
		const startOffset = asNumber(row, 'start_offset');
		const role = asString(row, 'role');
		const key = occurrenceContextKey(path, startOffset, role);

		return toReference(row, contexts.get(key) ?? []);
	});
};
