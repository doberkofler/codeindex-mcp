import {type DatabaseSync} from 'node:sqlite';
import {type BindingDetailType, type BindingSiteSummaryType, type BindingSummaryType, type ContextExposureType, type ExactNamePresenceType} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';
import {exposureOf, siteKindOf} from './databasePublicationRows.ts';

/** One symbol candidate before symbol-level deduplication. */
export type BindingCandidateType = Readonly<{
	readonly binding: BindingSummaryType;
	/** Identifier of the owning symbol; the summary is loaded for the emitted page only. */
	readonly symbolId: string;
	readonly match: 'exact_qualified' | 'exact_name' | 'prefix_qualified' | 'prefix_name';
	/** Whether a declared or default source site introduces this binding. */
	readonly hasDeclaredSite: boolean;
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
		? 'n.exposure'
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

/** Input shared by the production candidate statement and its plan capture. */
export type BindingCandidateQueryType = Readonly<{
	readonly generationId: string;
	readonly query: string;
	readonly match: 'name' | 'qualified';
	readonly kind?: string | undefined;
	readonly container?: string | undefined;
	readonly path?: string | undefined;
	readonly context?: string | undefined;
	readonly exposure: 'published' | 'reachable' | 'visible' | 'internal' | 'any';
	readonly fetchLimit: number;
}>;

/**
 * Builds the symbol candidate statement used by the hot page path.
 *
 * Exported so benchmarks and plan tests explain the production statement
 * rather than a hand-maintained copy.
 *
 * @param input - Generation, match mode, filters, and fetch bound.
 * @returns Statement text and bound parameters.
 */
export const bindingCandidateQuery = (input: BindingCandidateQueryType): Readonly<{sql: string; parameters: readonly (string | number)[]}> => {
	const field = input.match === 'qualified' ? 'n.qualified_name' : 'n.name';
	const upper = `${input.query}\uFFFF`;
	const contextFilter = contextClause(input.context, 'n');
	const parameters: (string | number)[] = input.context === undefined ? [input.generationId] : [input.context, input.generationId];

	parameters.push(input.query, upper);

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

	const symbolJoin = input.kind === undefined ? '' : 'join symbol s on s.generation_id = n.generation_id and s.id = n.symbol_id';

	return {
		sql: `select n.binding_id, n.symbol_id, n.name, n.container, n.qualified_name, ${exposureExpression} as exposure, n.has_declared_site
		from symbol_name n
		${symbolJoin}
		where n.generation_id = ?
		and ${field} >= ? and ${field} < ?
		${input.kind === undefined ? '' : ' and s.kind = ?'}
		${input.container === undefined ? '' : ' and n.container = ?'}
		${input.path === undefined ? '' : ` and exists (select 1 from occurrence o where o.generation_id = n.generation_id and o.symbol_id = n.symbol_id and o.role = 'definition' and o.path = ?)`}
		${contextFilter.sql}
		${exposure.sql}
		order by n.name, n.container, n.binding_id
		limit ?`,
		parameters,
	};
};

const scanBindingCandidates = (reader: DatabaseSync, input: BindingCandidateQueryType): readonly BindingCandidateType[] => {
	const {sql, parameters} = bindingCandidateQuery(input);
	const rows = reader.prepare(sql).all(...parameters);

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
			symbolId: asString(row, 'symbol_id'),
			match: exact
				? input.match === 'qualified'
					? ('exact_qualified' as const)
					: ('exact_name' as const)
				: input.match === 'qualified'
					? ('prefix_qualified' as const)
					: ('prefix_name' as const),
			hasDeclaredSite: asNumber(row, 'has_declared_site') === 1,
		};
	});
};

const DISPLAY_MARKERS = ['::', '['] as const;
const CONTAINER_BOUNDARIES = ['::', '.'] as const;

/**
 * Splits one natural qualified name into its container suffix and final name.
 *
 * Display-form names already carry explicit scope markers, so they are not
 * natural names and must keep their exact comparison behavior.
 *
 * @param query - Authored qualified name.
 * @returns Container suffix and terminal name, or null when the name is not natural.
 */
const naturalQualifiedPartsOf = (query: string): Readonly<{container: string; name: string}> | null => {
	if (query.length === 0 || DISPLAY_MARKERS.some((marker) => query.includes(marker))) {
		return null;
	}

	const separator = query.lastIndexOf('.');

	if (separator <= 0 || separator === query.length - 1) {
		return null;
	}

	return {container: query.slice(0, separator), name: query.slice(separator + 1)};
};

// Requires the authored container suffix to end the stored container at a member boundary.
const isContainerSuffixOf = (container: string, suffix: string): boolean =>
	container === suffix || CONTAINER_BOUNDARIES.some((boundary) => container.endsWith(`${boundary}${suffix}`));

/**
 * Finds bindings that satisfy a symbol-search filter before deduplication.
 *
 * The candidate statement reads only `symbol_name` and orders by the indexed
 * `(name, container, binding_id)` tuple. Symbol summaries are loaded later for
 * the emitted page, so a page never joins the symbol table for every candidate.
 *
 * A qualified query without display markers falls back to natural container
 * resolution: the terminal segment must equal the binding name and the
 * preceding segments must end the binding container at a `::` or `.` boundary.
 * The fallback runs only when the direct lookup is empty, so existing results
 * and their ranking never change.
 *
 * @param reader - Reader connection.
 * @param input - Generation, match mode, filters, and fetch bound.
 * @returns Binding candidates with their owning symbol identifiers.
 */
export const findBindingCandidates = (reader: DatabaseSync, input: BindingCandidateQueryType): readonly BindingCandidateType[] => {
	const candidates = scanBindingCandidates(reader, input);

	if (candidates.length > 0 || input.match !== 'qualified' || input.container !== undefined) {
		return candidates;
	}

	const natural = naturalQualifiedPartsOf(input.query);

	if (natural === null) {
		return candidates;
	}

	return scanBindingCandidates(reader, {...input, query: natural.name, match: 'name'})
		.filter((candidate) => candidate.binding.name === natural.name && isContainerSuffixOf(candidate.binding.container, natural.container))
		.map((candidate) => ({...candidate, match: 'exact_qualified' as const}));
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
			`select n.binding_id, n.symbol_id, n.name, n.container, n.qualified_name, n.exposure
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
