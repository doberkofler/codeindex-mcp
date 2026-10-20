import {type DatabaseSync} from 'node:sqlite';
import {type FindReferencesInputType, type ReferenceOwnerSummaryType, type ReferenceType} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';
import {asNullableString} from './databasePublicationRows.ts';

const occurrenceContexts = (
	reader: DatabaseSync,
	generationId: string,
	occurrences: readonly {symbolId: string; path: string; startOffset: number; role: string}[],
): ReadonlyMap<string, readonly string[]> => {
	if (occurrences.length === 0) {
		return new Map();
	}

	const symbolIds = [...new Set(occurrences.map((occurrence) => occurrence.symbolId))];
	const rows = reader
		.prepare(
			`select symbol_id, path, start_offset, role, context_name from occurrence_context
			 where generation_id = ? and symbol_id in (${placeholders(symbolIds.length)})
			 order by path, start_offset, role, context_name`,
		)
		.all(generationId, ...symbolIds);
	const groups = new Map<string, string[]>();

	for (const row of rows) {
		const key = [asString(row, 'path'), String(asNumber(row, 'start_offset')), asString(row, 'role')].join('\u0000');
		const group = groups.get(key) ?? [];
		group.push(asString(row, 'context_name'));
		groups.set(key, group);
	}

	return groups;
};

/**
 * Reads a page of reference occurrences with owner summaries and context filters.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, filters, and page bounds.
 * @returns Occurrences in deterministic path order.
 */
export const referenceRows = (
	reader: DatabaseSync,
	input: FindReferencesInputType & Readonly<{generationId: string; offset: number}>,
): readonly ReferenceType[] => {
	const parameters: (string | number)[] = [input.generationId, input.symbolId];
	const clauses: string[] = [];

	if (input.role !== undefined) {
		clauses.push('o.role = ?');
		parameters.push(input.role);
	}

	if (input.path !== undefined) {
		clauses.push('o.path = ?');
		parameters.push(input.path);
	}

	if (input.enclosingId !== undefined) {
		clauses.push('o.enclosing_id = ?');
		parameters.push(input.enclosingId);
	}

	if (input.usage !== undefined) {
		clauses.push('o.usage = ?');
		parameters.push(input.usage);
	}

	if (input.context !== undefined) {
		clauses.push(
			`exists (select 1 from occurrence_context oc where oc.generation_id = o.generation_id and oc.symbol_id = o.symbol_id and oc.path = o.path and oc.start_offset = o.start_offset and oc.role = o.role and oc.context_name = ?)`,
		);
		parameters.push(input.context);
	}

	parameters.push(input.limit + 1, input.offset);
	const rows = reader
		.prepare(
			`select o.symbol_id, o.path, o.start_offset, o.end_offset, o.start_line, o.start_column, o.end_line, o.end_column,
				o.role, o.usage, o.enclosing_id, s.name as owner_name, s.kind as owner_kind, s.path as owner_path, s.start_line as owner_start_line
			 from occurrence o
			 left join symbol s on s.generation_id = o.generation_id and s.id = o.enclosing_id
			 where o.generation_id = ? and o.symbol_id = ?${clauses.length === 0 ? '' : ` and ${clauses.join(' and ')}`}
			 order by o.path, o.start_offset, o.role, o.symbol_id, o.end_offset
			 limit ? offset ?`,
		)
		.all(...parameters);
	const contextGroups = occurrenceContexts(
		reader,
		input.generationId,
		rows.map((row) => ({
			symbolId: asString(row, 'symbol_id'),
			path: asString(row, 'path'),
			startOffset: asNumber(row, 'start_offset'),
			role: asString(row, 'role'),
		})),
	);

	return rows.map((row) => {
		const ownerId = asNullableString(row, 'enclosing_id');
		const owner: ReferenceOwnerSummaryType | null =
			ownerId === null
				? null
				: {
						symbolId: ownerId,
						name: asString(row, 'owner_name'),
						kind: asString(row, 'owner_kind'),
						path: asString(row, 'owner_path'),
						startLine: asNumber(row, 'owner_start_line'),
					};
		const key = [asString(row, 'path'), String(asNumber(row, 'start_offset')), asString(row, 'role')].join('\u0000');

		return {
			symbolId: asString(row, 'symbol_id'),
			path: asString(row, 'path'),
			startOffset: asNumber(row, 'start_offset'),
			endOffset: asNumber(row, 'end_offset'),
			startLine: asNumber(row, 'start_line'),
			startColumn: asNumber(row, 'start_column'),
			endLine: asNumber(row, 'end_line'),
			endColumn: asNumber(row, 'end_column'),
			role: asString(row, 'role') === 'definition' ? 'definition' : 'reference',
			usage: asNumber(row, 'usage'),
			enclosingId: ownerId,
			owner,
			contexts: contextGroups.get(key) ?? [],
		};
	});
};

/**
 * Reads unclassified reference count and cross-file reference presence for one symbol.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, and active filters.
 * @returns Coverage counters for the filtered scope.
 */
export const referenceCoverage = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; symbolId: string; filters: FindReferencesInputType}>,
): Readonly<{unclassifiedReferences: number; crossFileRefsObserved: boolean}> => {
	const clauses = [`generation_id = ?`, `symbol_id = ?`];
	const parameters: (string | number)[] = [input.generationId, input.symbolId];

	if (input.filters.path !== undefined) {
		clauses.push('path = ?');
		parameters.push(input.filters.path);
	}

	if (input.filters.enclosingId !== undefined) {
		clauses.push('enclosing_id = ?');
		parameters.push(input.filters.enclosingId);
	}

	if (input.filters.context !== undefined) {
		clauses.push(
			`exists (select 1 from occurrence_context oc where oc.generation_id = occurrence.generation_id and oc.symbol_id = occurrence.symbol_id and oc.path = occurrence.path and oc.start_offset = occurrence.start_offset and oc.role = occurrence.role and oc.context_name = ?)`,
		);
		parameters.push(input.filters.context);
	}

	const row = reader
		.prepare(
			`select
				(select count(*) from occurrence where ${clauses.join(' and ')} and role = 'reference' and usage = 0) as unclassified,
				(select count(*) from occurrence where ${clauses.join(' and ')} and role = 'reference' and path <> (select path from symbol where generation_id = ? and id = ?)) as cross_file
			 from (select 1)`,
		)
		.get(...parameters, ...parameters, input.generationId, input.symbolId);

	if (row === undefined) {
		return {unclassifiedReferences: 0, crossFileRefsObserved: false};
	}

	return {
		unclassifiedReferences: asNumber(row, 'unclassified'),
		crossFileRefsObserved: asNumber(row, 'cross_file') > 0,
	};
};
