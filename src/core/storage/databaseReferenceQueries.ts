import {type DatabaseSync} from 'node:sqlite';
import {type ReferenceOwnerSummaryType, type ReferenceType} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';
import {asNullableString} from './databasePublicationRows.ts';

/** Filters shared by every reference occurrence query. */
export type ReferenceScopeType = Readonly<{
	readonly generationId: string;
	/** Seed symbol; the only member of the default partition. */
	readonly symbolId: string;
	/**
	 * Complete symbol set of the selected partition.
	 *
	 * The default partition omits this and reads exactly `symbolId`. An external
	 * alias group supplies every member, so one query returns the group without
	 * fanning out one stored occurrence into several symbols.
	 */
	readonly symbolIds?: readonly string[] | undefined;
	readonly role?: 'definition' | 'reference' | undefined;
	readonly path?: string | undefined;
	readonly enclosingId?: string | undefined;
	readonly usage?: number | undefined;
	readonly context?: string | undefined;
	/** Optional adapter filter; occurrences inherit their symbol's adapter. */
	readonly adapter?: string | undefined;
}>;

const symbolIdsOf = (input: ReferenceScopeType): readonly string[] =>
	input.symbolIds === undefined || input.symbolIds.length === 0 ? [input.symbolId] : input.symbolIds;

const symbolClauseOf = (input: ReferenceScopeType, alias: string): Readonly<{sql: string; parameters: readonly string[]}> => {
	const symbolIds = symbolIdsOf(input);

	if (symbolIds.length === 1) {
		return {
			sql: `${alias}.symbol_key = (
				select symbol_key from symbol
				where generation_key = (select generation_key from generation where id = ?) and id = ?)`,
			parameters: [input.generationId, ...symbolIds],
		};
	}

	return {
		sql: `${alias}.symbol_key in (
			select symbol_key from symbol
			where generation_key = (select generation_key from generation where id = ?)
			and id in (${placeholders(symbolIds.length)}))`,
		parameters: [input.generationId, ...symbolIds],
	};
};

/** One usage bucket inside a file or owner group. */
export type ReferenceGroupRowType = Readonly<{
	readonly path: string;
	readonly adapter: string;
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
	const symbolClause = symbolClauseOf(input, alias);
	const clauses: string[] = [`${alias}.generation_key = (select generation_key from generation where id = ?)`, symbolClause.sql];
	const parameters: (string | number)[] = [input.generationId, ...symbolClause.parameters];

	if (input.role !== undefined) {
		clauses.push(`${alias}.role = ?`);
		parameters.push(input.role);
	}

	if (input.path !== undefined) {
		clauses.push(`${alias}.path_order = ?`);
		parameters.push(input.path);
	}

	if (input.enclosingId !== undefined) {
		clauses.push(
			`${alias}.enclosing_symbol_key = (
				select symbol_key from symbol
				where generation_key = ${alias}.generation_key and id = ?)`,
		);
		parameters.push(input.enclosingId);
	}

	if (input.usage !== undefined) {
		clauses.push(`${alias}.usage = ?`);
		parameters.push(input.usage);
	}

	if (input.adapter !== undefined) {
		clauses.push(`${alias}.adapter_id = ?`);
		parameters.push(input.adapter);
	}

	if (input.context !== undefined) {
		clauses.push(
			`exists (select 1 from occurrence_context oc
				join project_context pc on pc.context_key = oc.context_key
				where oc.occurrence_key = ${alias}.occurrence_key and pc.name = ?)`,
		);
		parameters.push(input.context);
	}

	return {sql: clauses.join(' and '), parameters};
};

const definitionClauses = (input: ReferenceScopeType, alias: string): Readonly<{sql: string; parameters: readonly (string | number)[]}> => {
	const symbolClause = symbolClauseOf(input, alias);
	const clauses: string[] = [
		`${alias}.generation_key = (select generation_key from generation where id = ?)`,
		symbolClause.sql,
		`${alias}.role = 'definition'`,
	];
	const parameters: (string | number)[] = [input.generationId, ...symbolClause.parameters];

	if (input.path !== undefined) {
		clauses.push(`${alias}.path_order = ?`);
		parameters.push(input.path);
	}

	if (input.enclosingId !== undefined) {
		clauses.push(
			`${alias}.enclosing_symbol_key = (
				select symbol_key from symbol
				where generation_key = ${alias}.generation_key and id = ?)`,
		);
		parameters.push(input.enclosingId);
	}

	if (input.adapter !== undefined) {
		clauses.push(`${alias}.adapter_id = ?`);
		parameters.push(input.adapter);
	}

	if (input.context !== undefined) {
		clauses.push(
			`exists (select 1 from occurrence_context oc
				join project_context pc on pc.context_key = oc.context_key
				where oc.occurrence_key = ${alias}.occurrence_key and pc.name = ?)`,
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
			`select s.id as symbol_id, f.path, o.start_offset, o.role, pc.name as context_name
			 from occurrence_context oc
			 join occurrence o on o.occurrence_key = oc.occurrence_key
			 join symbol s on s.symbol_key = o.symbol_key
			 join file f on f.file_key = o.file_key
			 join project_context pc on pc.context_key = oc.context_key
			 where o.generation_key = (select generation_key from generation where id = ?)
			 and s.id in (${placeholders(symbolIds.length)})
			 order by f.path, o.start_offset, o.role, pc.name`,
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
		sql: `select target.id as symbol_id, o.adapter_id, f.path, o.start_offset, o.end_offset, o.start_line, o.start_column, o.end_line, o.end_column,
				o.role, o.usage, owner.id as enclosing_id, owner.name as owner_name, owner.kind as owner_kind,
				(select path from file where file_key = owner.file_key) as owner_path, owner.start_line as owner_start_line
			 from occurrence o
			 join symbol target on target.symbol_key = o.symbol_key
			 join file f on f.file_key = o.file_key
			 left join symbol owner on owner.symbol_key = o.enclosing_symbol_key
			 where ${clauses}
			 order by o.path_order, o.start_offset, o.role, o.symbol_id_order, o.end_offset
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
			adapter: asString(row, 'adapter_id'),
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
 * Builds the reference-coverage statement used after every occurrence page.
 *
 * Symbol and file membership stay uncorrelated so SQLite starts from the
 * symbol-key occurrence index instead of scanning every occurrence in a
 * generation.
 *
 * @param input - Generation, symbol, and active filters.
 * @returns Statement text and bound parameters.
 */
export const referenceCoverageQuery = (
	input: Readonly<{generationId: string; symbolId: string; filters: ReferenceScopeType}>,
): Readonly<{sql: string; parameters: readonly (string | number)[]}> => {
	const scope: ReferenceScopeType = {...input.filters, generationId: input.generationId, symbolId: input.symbolId};
	const symbolIds = symbolIdsOf(scope);
	const symbolClause = symbolClauseOf(scope, 'o');
	const coverageClauses: string[] = [symbolClause.sql];
	const coverageParameters: (string | number)[] = [...symbolClause.parameters];

	if (scope.path !== undefined) {
		coverageClauses.push('o.path_order = ?');
		coverageParameters.push(scope.path);
	}

	if (scope.enclosingId !== undefined) {
		coverageClauses.push(
			`o.enclosing_symbol_key = (
				select symbol_key from symbol
				where generation_key = o.generation_key and id = ?)`,
		);
		coverageParameters.push(scope.enclosingId);
	}

	if (scope.context !== undefined) {
		coverageClauses.push(
			`exists (
				select 1 from occurrence_context oc
				join project_context pc on pc.context_key = oc.context_key
				where oc.occurrence_key = o.occurrence_key and pc.name = ?)`,
		);
		coverageParameters.push(scope.context);
	}

	return {
		sql: `select
				(select count(*) from occurrence o where ${coverageClauses.join(' and ')} and o.role = 'reference' and o.usage = 0) as unclassified,
				(select count(*) from occurrence o where ${coverageClauses.join(' and ')} and o.role = 'reference'
				 and o.file_key not in (
					select file_key from symbol
					where generation_key = (select generation_key from generation where id = ?)
					and id in (${placeholders(symbolIds.length)}))) as cross_file
			 from (select 1)`,
		parameters: [...coverageParameters, ...coverageParameters, input.generationId, ...symbolIds],
	};
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
	const {sql, parameters} = referenceCoverageQuery(input);
	const row = reader.prepare(sql).get(...parameters);

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
 * Counts stored definition occurrences for each requested symbol.
 *
 * The default partition always has one member; an external alias group has
 * several. A member without a definition cannot prove its partition complete,
 * so the count feeds the result completeness axis instead of a drop counter.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolIds - Symbol identifiers in the selected partition.
 * @returns Definition count per symbol, with missing symbols omitted.
 */
export const definitionCountsBySymbol = (reader: DatabaseSync, generationId: string, symbolIds: readonly string[]): ReadonlyMap<string, number> => {
	if (symbolIds.length === 0) {
		return new Map();
	}

	const rows = reader
		.prepare(
			`select s.id as symbol_id, count(*) as definitions
			 from occurrence o
			 join symbol s on s.symbol_key = o.symbol_key
			 where o.generation_key = (select generation_key from generation where id = ?)
			 and s.id in (${placeholders(symbolIds.length)}) and o.role = 'definition'
			 group by s.id`,
		)
		.all(generationId, ...symbolIds);

	return new Map(rows.map((row) => [asString(row, 'symbol_id'), asNumber(row, 'definitions')]));
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
			`select f.path, o.adapter_id, owner.id as enclosing_id, o.usage, count(*) as occurrence_count,
				owner.name as owner_name, owner.kind as owner_kind,
				(select path from file where file_key = owner.file_key) as owner_path, owner.start_line as owner_start_line
			 from occurrence o
			 join file f on f.file_key = o.file_key
			 left join symbol owner on owner.symbol_key = o.enclosing_symbol_key
			 where ${clauses}
			 group by f.path, o.adapter_id, o.enclosing_symbol_key, o.usage,
				owner.id, owner.name, owner.kind, owner.file_key, owner.start_line
			 order by f.path, owner.id, o.usage`,
		)
		.all(...parameters);

	return rows.map((row) => {
		const ownerId = asNullableString(row, 'enclosing_id');

		return {
			path: asString(row, 'path'),
			adapter: asString(row, 'adapter_id'),
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
			`select distinct f.path, o.adapter_id, owner.id as enclosing_id, pc.name as context_name
			 from occurrence o
			 join file f on f.file_key = o.file_key
			 left join symbol owner on owner.symbol_key = o.enclosing_symbol_key
			 join occurrence_context oc on oc.occurrence_key = o.occurrence_key
			 join project_context pc on pc.context_key = oc.context_key
			 where ${clauses}
			 order by f.path, owner.id, pc.name`,
		)
		.all(...parameters);

	return rows.map((row) => ({
		path: asString(row, 'path'),
		enclosingId: asNullableString(row, 'enclosing_id'),
		contextName: asString(row, 'context_name'),
	}));
};
