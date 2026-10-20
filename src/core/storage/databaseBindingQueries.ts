import {type DatabaseSync} from 'node:sqlite';
import {
	type BindingDetailType,
	type BindingSiteSummaryType,
	type BindingSummaryType,
	type ContextExposureType,
	type ExactNamePresenceType,
	type SymbolSummaryType,
} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';
import {BINDING_COLUMNS, EXPOSURE_ORDER, exposureOf, siteKindOf, toSymbolSummary} from './databasePublicationRows.ts';

/** One symbol candidate before symbol-level deduplication. */
export type BindingCandidateType = Readonly<{
	readonly binding: BindingSummaryType;
	readonly symbol: SymbolSummaryType;
	readonly match: 'exact_qualified' | 'exact_name' | 'prefix_qualified' | 'prefix_name';
}>;

const contextClause = (context: string | undefined, alias: string): Readonly<{sql: string; parameters: readonly string[]}> =>
	context === undefined
		? {sql: '', parameters: []}
		: {
				sql: ` and exists (select 1 from symbol_name_context c where c.generation_id = ${alias}.generation_id and c.binding_id = ${alias}.binding_id and c.context_name = ?)`,
				parameters: [context],
			};

const exposureColumn = (context: string | undefined): string =>
	context === undefined
		? `(select c.exposure from symbol_name_context c where c.generation_id = n.generation_id and c.binding_id = n.binding_id order by ${EXPOSURE_ORDER} desc limit 1)`
		: `(select c.exposure from symbol_name_context c where c.generation_id = n.generation_id and c.binding_id = n.binding_id and c.context_name = ? limit 1)`;

export const symbolContextsForRows = (reader: DatabaseSync, generationId: string, symbolIds: readonly string[]): ReadonlyMap<string, readonly string[]> => {
	if (symbolIds.length === 0) {
		return new Map();
	}

	const rows = reader
		.prepare(
			`select symbol_id, context_name from symbol_context
			 where generation_id = ? and symbol_id in (${placeholders(symbolIds.length)})
			 order by symbol_id, context_name`,
		)
		.all(generationId, ...symbolIds);
	const groups = new Map<string, string[]>();

	for (const row of rows) {
		const key = asString(row, 'symbol_id');
		const group = groups.get(key) ?? [];
		group.push(asString(row, 'context_name'));
		groups.set(key, group);
	}

	return groups;
};

const exposureFilter = (
	exposure: 'published' | 'reachable' | 'visible' | 'internal' | 'any',
	expression: string,
): Readonly<{sql: string; parameters: readonly string[]}> => {
	if (exposure === 'any') {
		return {sql: '', parameters: []};
	}

	if (exposure === 'visible') {
		return {sql: ` and ${expression} in (?, ?)`, parameters: ['published', 'reachable']};
	}

	return {sql: ` and ${expression} = ?`, parameters: [exposure]};
};

const EXACT_NAME_PRESENCES: readonly ExactNamePresenceType[] = ['none', 'P', 'R', 'I', 'PR', 'PI', 'RI', 'PRI'];

/**
 * Reports which exposure classes hold an exact-name binding.
 *
 * The measurement is independent of the caller's exposure filter so query
 * telemetry can compare candidate defaults without changing the result.
 *
 * @param reader - Reader connection.
 * @param input - Generation, exact canonical name, and optional context.
 * @returns Presence bitmask over published, reachable, and internal bindings.
 */
export const exactNamePresence = (
	reader: DatabaseSync,
	input: Readonly<{readonly generationId: string; readonly name: string; readonly context?: string | undefined}>,
): ExactNamePresenceType => {
	const exposureExpression = exposureColumn(input.context);
	const contextFilter = contextClause(input.context, 'n');
	const parameters: string[] = input.context === undefined ? [input.generationId, input.name] : [input.context, input.generationId, input.name];
	const rows = reader
		.prepare(
			`select distinct ${exposureExpression} as exposure
			 from symbol_name n
			 where n.generation_id = ?
			 and n.name = ?
			 ${contextFilter.sql}`,
		)
		.all(...parameters, ...contextFilter.parameters);
	const present = new Set(rows.map((row) => exposureOf(asString(row, 'exposure'))));
	const bits = `${present.has('published') ? 'P' : ''}${present.has('reachable') ? 'R' : ''}${present.has('internal') ? 'I' : ''}`;

	return EXACT_NAME_PRESENCES.find((presence) => presence === bits) ?? 'none';
};

/**
 * Finds bindings that satisfy a symbol-search filter before deduplication.
 *
 * @param reader - Reader connection.
 * @param input - Generation, match mode, filters, and fetch bound.
 * @returns Binding candidates with their owning symbols.
 */
export const findBindingCandidates = (
	reader: DatabaseSync,
	input: Readonly<{
		readonly generationId: string;
		readonly query: string;
		readonly match: 'name' | 'qualified';
		readonly kind?: string | undefined;
		readonly container?: string | undefined;
		readonly path?: string | undefined;
		readonly context?: string | undefined;
		readonly exposure: 'published' | 'reachable' | 'visible' | 'internal' | 'any';
		readonly fetchLimit: number;
	}>,
): readonly BindingCandidateType[] => {
	const field = input.match === 'qualified' ? 'n.qualified_name' : 'n.name';
	const upper = `${input.query}\uFFFF`;
	const contextFilter = contextClause(input.context, 'n');
	const parameters: (string | number)[] = input.context === undefined ? [input.generationId] : [input.context, input.generationId];

	parameters.push(input.query, input.query, upper);

	if (input.kind !== undefined) {
		parameters.push(input.kind);
	}

	if (input.container !== undefined) {
		parameters.push(input.container);
	}

	if (input.path !== undefined) {
		parameters.push(input.path);
	}

	const exposureExpression = exposureColumn(input.context);
	const exposure = exposureFilter(input.exposure, exposureExpression);

	const exposureContext = input.context === undefined || exposure.sql === '' ? [] : [input.context];

	parameters.push(...contextFilter.parameters, ...exposureContext, ...exposure.parameters, input.fetchLimit);

	const sql = `select ${BINDING_COLUMNS}, ${exposureExpression} as exposure
		from symbol_name n
		join symbol s on s.generation_id = n.generation_id and s.id = n.symbol_id
		where n.generation_id = ?
		and (${field} = ? or (${field} >= ? and ${field} < ?))
		${input.kind === undefined ? '' : ' and s.kind = ?'}
		${input.container === undefined ? '' : ' and n.container = ?'}
		${input.path === undefined ? '' : ` and exists (select 1 from occurrence o where o.generation_id = n.generation_id and o.symbol_id = n.symbol_id and o.role = 'definition' and o.path = ?)`}
		${contextFilter.sql}
		${exposure.sql}
		order by n.name, n.container, n.binding_id
		limit ?`;

	const rows = reader.prepare(sql).all(...parameters);
	const contexts = symbolContextsForRows(
		reader,
		input.generationId,
		rows.map((row) => asString(row, 'symbol_id')),
	);

	return rows.map((row) => {
		const name = asString(row, 'name');
		const qualifiedName = asString(row, 'qualified_name');
		const exact = input.match === 'qualified' ? qualifiedName === input.query : name === input.query;
		const bindingExposure = exposureOf(asString(row, 'exposure'));

		return {
			binding: {
				bindingId: asString(row, 'binding_id'),
				name,
				container: asString(row, 'container'),
				qualifiedName,
				exposure: bindingExposure,
				inRequestedContext: input.context === undefined ? null : true,
			},
			symbol: toSymbolSummary(row, contexts.get(asString(row, 'symbol_id')) ?? []),
			match: exact
				? input.match === 'qualified'
					? ('exact_qualified' as const)
					: ('exact_name' as const)
				: input.match === 'qualified'
					? ('prefix_qualified' as const)
					: ('prefix_name' as const),
		};
	});
};

/**
 * Reads binding contexts by binding identifier.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param bindingIds - Binding identifiers in the page.
 * @returns Context/exposure rows grouped by binding.
 */
export const bindingContextsFor = (
	reader: DatabaseSync,
	generationId: string,
	bindingIds: readonly string[],
): ReadonlyMap<string, readonly ContextExposureType[]> => {
	if (bindingIds.length === 0) {
		return new Map();
	}

	const rows = reader
		.prepare(
			`select binding_id, context_name, exposure from symbol_name_context
			 where generation_id = ? and binding_id in (${placeholders(bindingIds.length)})
			 order by binding_id, context_name`,
		)
		.all(generationId, ...bindingIds);
	const groups = new Map<string, ContextExposureType[]>();

	for (const row of rows) {
		const key = asString(row, 'binding_id');
		const group = groups.get(key) ?? [];
		group.push({contextName: asString(row, 'context_name'), exposure: exposureOf(asString(row, 'exposure'))});
		groups.set(key, group);
	}

	return groups;
};

/**
 * Reads binding sites by binding identifier.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param bindingIds - Binding identifiers in the page.
 * @returns Source sites grouped by binding.
 */
export const bindingSitesFor = (
	reader: DatabaseSync,
	generationId: string,
	bindingIds: readonly string[],
): ReadonlyMap<string, readonly BindingSiteSummaryType[]> => {
	if (bindingIds.length === 0) {
		return new Map();
	}

	const rows = reader
		.prepare(
			`select binding_id, kind, path, start_offset, end_offset from symbol_name_site
			 where generation_id = ? and binding_id in (${placeholders(bindingIds.length)})
			 order by binding_id,
				case kind when 'declared' then 0 when 'default' then 1 when 'alias' then 2 when 'reexport' then 3 when 'wildcard' then 4 when 'commonjs' then 5 else 6 end,
				path, start_offset`,
		)
		.all(generationId, ...bindingIds);
	const groups = new Map<string, BindingSiteSummaryType[]>();

	for (const row of rows) {
		const key = asString(row, 'binding_id');
		const group = groups.get(key) ?? [];
		group.push({
			kind: siteKindOf(asString(row, 'kind')),
			path: asString(row, 'path'),
			start: asNumber(row, 'start_offset'),
			end: asNumber(row, 'end_offset'),
		});
		groups.set(key, group);
	}

	return groups;
};

/**
 * Reads every binding, context, and site for a page of symbols.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol identifiers, and optional context filter.
 * @returns Binding details grouped by symbol identifier.
 */
export const bindingDetailsForSymbols = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; symbolIds: readonly string[]; context?: string | undefined}>,
): ReadonlyMap<string, readonly BindingDetailType[]> => {
	if (input.symbolIds.length === 0) {
		return new Map();
	}

	const contextFilter =
		input.context === undefined
			? ''
			: ' and exists (select 1 from symbol_name_context c where c.generation_id = n.generation_id and c.binding_id = n.binding_id and c.context_name = ?)';
	const parameters = input.context === undefined ? [input.generationId, ...input.symbolIds] : [input.generationId, ...input.symbolIds, input.context];
	const rows = reader
		.prepare(
			`select n.binding_id, n.symbol_id, n.name, n.container, n.qualified_name,
				(select c.exposure from symbol_name_context c where c.generation_id = n.generation_id and c.binding_id = n.binding_id order by ${EXPOSURE_ORDER} desc limit 1) as exposure
			 from symbol_name n
			 where n.generation_id = ? and n.symbol_id in (${placeholders(input.symbolIds.length)})${contextFilter}
			 order by n.symbol_id, n.container, n.name, n.binding_id`,
		)
		.all(...parameters);
	const bindingIds = rows.map((row) => asString(row, 'binding_id'));
	const contexts = bindingContextsFor(reader, input.generationId, bindingIds);
	const sites = bindingSitesFor(reader, input.generationId, bindingIds);
	const groups = new Map<string, BindingDetailType[]>();

	for (const row of rows) {
		const bindingId = asString(row, 'binding_id');
		const contextRows = contexts.get(bindingId) ?? [];
		const siteRows = sites.get(bindingId) ?? [];
		const exposure = exposureOf(asString(row, 'exposure'));
		const detail: BindingDetailType = {
			bindingId,
			name: asString(row, 'name'),
			container: asString(row, 'container'),
			qualifiedName: asString(row, 'qualified_name'),
			exposure,
			inRequestedContext: input.context === undefined ? null : contextRows.some((context) => context.contextName === input.context),
			contexts: contextRows.slice(0, 3),
			contextsTotal: contextRows.length,
			contextsTruncated: contextRows.length > 3,
			sites: siteRows.slice(0, 3),
			sitesTotal: siteRows.length,
			sitesTruncated: siteRows.length > 3,
		};
		const group = groups.get(asString(row, 'symbol_id')) ?? [];
		group.push(detail);
		groups.set(asString(row, 'symbol_id'), group);
	}

	return groups;
};
