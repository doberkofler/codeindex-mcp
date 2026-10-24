import {type DatabaseSync} from 'node:sqlite';
import {type ReferenceOwnerSummaryType, type ReferenceType} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';
import {asNullableString} from './databasePublicationRows.ts';

/** Filters shared by every reference occurrence query. */
export type ReferenceScopeType = Readonly<{
	readonly generationId: string;
	readonly symbolId: string;
	readonly role?: 'definition' | 'reference' | undefined;
	readonly path?: string | undefined;
	readonly enclosingId?: string | undefined;
	readonly usage?: number | undefined;
	readonly context?: string | undefined;
}>;

/** One usage bucket inside a file or owner group. */
export type ReferenceGroupRowType = Readonly<{
	readonly path: string;
	readonly owner: ReferenceOwnerSummaryType | null;
	readonly usage: number;
	readonly count: number;
}>;

/** One distinct context name attached to a grouped path and owner. */
export type ReferenceGroupContextRowType = Readonly<{
	readonly path: string;
	readonly enclosingId: string | null;
	readonly contextName: string;
}>;

const occurrenceClauses = (input: ReferenceScopeType, alias: string): Readonly<{sql: string; parameters: readonly (string | number)[]}> => {
	const clauses: string[] = [`${alias}.generation_id = ?`, `${alias}.symbol_id = ?`];
	const parameters: (string | number)[] = [input.generationId, input.symbolId];

	if (input.role !== undefined) {
		clauses.push(`${alias}.role = ?`);
		parameters.push(input.role);
	}

	if (input.path !== undefined) {
		clauses.push(`${alias}.path = ?`);
		parameters.push(input.path);
	}

	if (input.enclosingId !== undefined) {
		clauses.push(`${alias}.enclosing_id = ?`);
		parameters.push(input.enclosingId);
	}

	if (input.usage !== undefined) {
		clauses.push(`${alias}.usage = ?`);
		parameters.push(input.usage);
	}

	if (input.context !== undefined) {
		clauses.push(
			`exists (select 1 from occurrence_context oc
				where oc.generation_id = ${alias}.generation_id and oc.symbol_id = ${alias}.symbol_id
				and oc.path = ${alias}.path and oc.start_offset = ${alias}.start_offset
				and oc.role = ${alias}.role and oc.context_name = ?)`,
		);
		parameters.push(input.context);
	}

	return {sql: clauses.join(' and '), parameters};
};

const definitionClauses = (input: ReferenceScopeType, alias: string): Readonly<{sql: string; parameters: readonly (string | number)[]}> => {
	const clauses: string[] = [`${alias}.generation_id = ?`, `${alias}.symbol_id = ?`, `${alias}.role = 'definition'`];
	const parameters: (string | number)[] = [input.generationId, input.symbolId];

	if (input.path !== undefined) {
		clauses.push(`${alias}.path = ?`);
		parameters.push(input.path);
	}

	if (input.enclosingId !== undefined) {
		clauses.push(`${alias}.enclosing_id = ?`);
		parameters.push(input.enclosingId);
	}

	if (input.context !== undefined) {
		clauses.push(
			`exists (select 1 from occurrence_context oc
				where oc.generation_id = ${alias}.generation_id and oc.symbol_id = ${alias}.symbol_id
				and oc.path = ${alias}.path and oc.start_offset = ${alias}.start_offset
				and oc.role = ${alias}.role and oc.context_name = ?)`,
		);
		parameters.push(input.context);
	}

	return {sql: clauses.join(' and '), parameters};
};

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
 * Builds the reference page statement used by the hot page path.
 *
 * Exported so benchmarks and plan tests explain the production statement
 * rather than a hand-maintained copy.
 *
 * @param input - Generation, symbol, filters, and page bounds.
 * @returns Statement text and bound parameters.
 */
export const referencePageQuery = (
	input: ReferenceScopeType & Readonly<{offset: number; limit: number}>,
): Readonly<{sql: string; parameters: readonly (string | number)[]}> => {
	const {sql: clauses, parameters: clauseParameters} = occurrenceClauses(input, 'o');

	return {
		sql: `select o.symbol_id, o.path, o.start_offset, o.end_offset, o.start_line, o.start_column, o.end_line, o.end_column,
				o.role, o.usage, o.enclosing_id, s.name as owner_name, s.kind as owner_kind, s.path as owner_path, s.start_line as owner_start_line
			 from occurrence o
			 left join symbol s on s.generation_id = o.generation_id and s.id = o.enclosing_id
			 where ${clauses}
			 order by o.path, o.start_offset, o.role, o.symbol_id, o.end_offset
			 limit ? offset ?`,
		parameters: [...clauseParameters, input.limit + 1, input.offset],
	};
};

/**
 * Reads a page of reference occurrences with owner summaries and context filters.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, filters, and page bounds.
 * @returns Occurrences in deterministic path order.
 */
export const referenceRows = (reader: DatabaseSync, input: ReferenceScopeType & Readonly<{offset: number; limit: number}>): readonly ReferenceType[] => {
	const {sql, parameters} = referencePageQuery(input);
	const rows = reader.prepare(sql).all(...parameters);
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
	input: Readonly<{generationId: string; symbolId: string; filters: ReferenceScopeType}>,
): Readonly<{unclassifiedReferences: number; crossFileRefsObserved: boolean}> => {
	const scope: ReferenceScopeType = {...input.filters, generationId: input.generationId, symbolId: input.symbolId};
	const coverageClauses: string[] = ['generation_id = ?', 'symbol_id = ?'];
	const coverageParameters: (string | number)[] = [input.generationId, input.symbolId];

	if (scope.path !== undefined) {
		coverageClauses.push('path = ?');
		coverageParameters.push(scope.path);
	}

	if (scope.enclosingId !== undefined) {
		coverageClauses.push('enclosing_id = ?');
		coverageParameters.push(scope.enclosingId);
	}

	if (scope.context !== undefined) {
		coverageClauses.push(
			`exists (select 1 from occurrence_context oc where oc.generation_id = occurrence.generation_id and oc.symbol_id = occurrence.symbol_id and oc.path = occurrence.path and oc.start_offset = occurrence.start_offset and oc.role = occurrence.role and oc.context_name = ?)`,
		);
		coverageParameters.push(scope.context);
	}

	const row = reader
		.prepare(
			`select
				(select count(*) from occurrence where ${coverageClauses.join(' and ')} and role = 'reference' and usage = 0) as unclassified,
				(select count(*) from occurrence where ${coverageClauses.join(' and ')} and role = 'reference' and path <> (select path from symbol where generation_id = ? and id = ?)) as cross_file
			 from (select 1)`,
		)
		.get(...coverageParameters, ...coverageParameters, input.generationId, input.symbolId);

	if (row === undefined) {
		return {unclassifiedReferences: 0, crossFileRefsObserved: false};
	}

	return {
		unclassifiedReferences: asNumber(row, 'unclassified'),
		crossFileRefsObserved: asNumber(row, 'cross_file') > 0,
	};
};

/**
 * Counts filtered occurrences and all definitions in the same path and context scope.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, and filters.
 * @returns The occurrence and definition totals.
 */
export const referenceTotals = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; symbolId: string; filters: ReferenceScopeType}>,
): Readonly<{occurrencesTotal: number; definitionsTotal: number}> => {
	const scope: ReferenceScopeType = {...input.filters, generationId: input.generationId, symbolId: input.symbolId};
	const occurrences = occurrenceClauses(scope, 'o');
	const definitions = definitionClauses(scope, 'o');
	const row = reader
		.prepare(
			`select
				(select count(*) from occurrence o where ${occurrences.sql}) as occurrences,
				(select count(*) from occurrence o where ${definitions.sql}) as definitions
			 from (select 1)`,
		)
		.get(...occurrences.parameters, ...definitions.parameters);

	if (row === undefined) {
		return {occurrencesTotal: 0, definitionsTotal: 0};
	}

	return {
		occurrencesTotal: asNumber(row, 'occurrences'),
		definitionsTotal: asNumber(row, 'definitions'),
	};
};

/**
 * Reads usage counts for every file and owner group in a filtered scope.
 *
 * Rows are already aggregated by usage so callers can union usage bits without
 * counting context rows.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, and filters.
 * @returns One row per usage bucket and group.
 */
export const referenceGroupRows = (reader: DatabaseSync, input: ReferenceScopeType): readonly ReferenceGroupRowType[] => {
	const {sql: clauses, parameters} = occurrenceClauses(input, 'o');
	const rows = reader
		.prepare(
			`select o.path, o.enclosing_id, o.usage, count(*) as occurrence_count,
				s.name as owner_name, s.kind as owner_kind, s.path as owner_path, s.start_line as owner_start_line
			 from occurrence o
			 left join symbol s on s.generation_id = o.generation_id and s.id = o.enclosing_id
			 where ${clauses}
			 group by o.path, o.enclosing_id, o.usage, s.name, s.kind, s.path, s.start_line
			 order by o.path, o.enclosing_id, o.usage`,
		)
		.all(...parameters);

	return rows.map((row) => {
		const ownerId = asNullableString(row, 'enclosing_id');

		return {
			path: asString(row, 'path'),
			owner:
				ownerId === null
					? null
					: {
							symbolId: ownerId,
							name: asString(row, 'owner_name'),
							kind: asString(row, 'owner_kind'),
							path: asString(row, 'owner_path'),
							startLine: asNumber(row, 'owner_start_line'),
						},
			usage: asNumber(row, 'usage'),
			count: asNumber(row, 'occurrence_count'),
		};
	});
};

/**
 * Reads distinct context names attached to filtered occurrences.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, and filters.
 * @returns Raw path/owner/context rows in deterministic order.
 */
export const referenceGroupContexts = (reader: DatabaseSync, input: ReferenceScopeType): readonly ReferenceGroupContextRowType[] => {
	const {sql: clauses, parameters} = occurrenceClauses(input, 'o');
	const rows = reader
		.prepare(
			`select distinct o.path, o.enclosing_id, oc.context_name
			 from occurrence o
			 join occurrence_context oc
				on oc.generation_id = o.generation_id and oc.symbol_id = o.symbol_id
				and oc.path = o.path and oc.start_offset = o.start_offset and oc.role = o.role
			 where ${clauses}
			 order by o.path, o.enclosing_id, oc.context_name`,
		)
		.all(...parameters);

	return rows.map((row) => ({
		path: asString(row, 'path'),
		enclosingId: asNullableString(row, 'enclosing_id'),
		contextName: asString(row, 'context_name'),
	}));
};
