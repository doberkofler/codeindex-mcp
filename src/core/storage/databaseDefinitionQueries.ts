import {type DatabaseSync} from 'node:sqlite';
import {type DefinitionSiteSummaryType, type OutlineReexportType, type SymbolSummaryType} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';
import {asNullableString, LineStartSchema, siteKindOf, toSymbolSummary} from './databasePublicationRows.ts';
import {symbolContextsForRows} from './databaseBindingQueries.ts';

type SqlRowType = Readonly<Record<string, unknown>>;

const definitionKey = (row: SqlRowType): string =>
	[asString(row, 'path'), String(asNumber(row, 'start_offset')), String(asNumber(row, 'end_offset'))].join('\u0000');

const primaryDefinitionKey = (rows: readonly SqlRowType[], rankField: 'primary_rank' | 'anchor_rank'): string => {
	let selected: SqlRowType | null = null;

	for (const row of rows) {
		if (selected === null) {
			selected = row;
			continue;
		}

		const rank = asNumber(row, rankField) - asNumber(selected, rankField);
		const path = asString(row, 'path').localeCompare(asString(selected, 'path'));
		const offset = asNumber(row, 'start_offset') - asNumber(selected, 'start_offset');

		if (rank < 0 || (rank === 0 && (path < 0 || (path === 0 && offset < 0)))) {
			selected = row;
		}
	}

	return selected === null ? '' : definitionKey(selected);
};

/**
 * Reads definition sites for a page of symbols in primary order.
 *
 * @param reader - Reader connection.
 * @param input - Generation and symbol identifiers.
 * @returns Definition sites grouped by symbol.
 */
export const definitionSitesForSymbols = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; symbolIds: readonly string[]}>,
): ReadonlyMap<string, readonly DefinitionSiteSummaryType[]> => {
	if (input.symbolIds.length === 0) {
		return new Map();
	}

	const rows = reader
		.prepare(
			`select d.site_id, s.id as symbol_id, f.path, o.start_offset, o.end_offset, o.start_line, o.start_column, o.end_line, o.end_column,
				o.declaration_kind, o.forward_definition, o.primary_rank, o.anchor_rank, o.extent_start, o.extent_end
			 from definition_site d
			 join occurrence o on o.occurrence_key = d.occurrence_key
			 join symbol s on s.symbol_key = d.symbol_key
			 join file f on f.file_key = d.file_key
			 where d.generation_key = (select generation_key from generation where id = ?)
			 and s.id in (${placeholders(input.symbolIds.length)})
			 order by s.id, o.primary_rank, f.path, d.start_offset, o.end_offset`,
		)
		.all(input.generationId, ...input.symbolIds);
	const grouped = new Map<string, SqlRowType[]>();

	for (const row of rows) {
		const key = asString(row, 'symbol_id');
		const group = grouped.get(key) ?? [];
		group.push(row);
		grouped.set(key, group);
	}

	const result = new Map<string, DefinitionSiteSummaryType[]>();

	for (const [symbolId, group] of grouped) {
		const primaryKey = primaryDefinitionKey(group, 'primary_rank');
		const anchorKey = primaryDefinitionKey(group, 'anchor_rank');
		result.set(
			symbolId,
			group.map((row) => ({
				siteId: asString(row, 'site_id'),
				path: asString(row, 'path'),
				nameStart: asNumber(row, 'start_offset'),
				nameEnd: asNumber(row, 'end_offset'),
				extentStart: asNumber(row, 'extent_start'),
				extentEnd: asNumber(row, 'extent_end'),
				startLine: asNumber(row, 'start_line'),
				endLine: asNumber(row, 'end_line'),
				declarationKind: asString(row, 'declaration_kind'),
				forwardDefinition: asNumber(row, 'forward_definition') === 1,
				primary: definitionKey(row) === primaryKey,
				identityAnchor: definitionKey(row) === anchorKey,
			})),
		);
	}

	return result;
};

/**
 * Reads symbol summaries and their project contexts by identifier.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolIds - Symbol identifiers to load.
 * @returns A summary per requested identifier that exists in the generation.
 */
export const symbolSummariesByIds = (reader: DatabaseSync, generationId: string, symbolIds: readonly string[]): ReadonlyMap<string, SymbolSummaryType> => {
	if (symbolIds.length === 0) {
		return new Map();
	}

	const rows = reader
		.prepare(
			`select s.id as symbol_id, s.name, s.qualified_name, s.kind, s.adapter_id, f.path, s.start_line, s.start_column,
				s.end_line, s.end_column, s.start_offset, s.end_offset, parent.id as enclosing_id, s.external_target, s.external_name
			 from symbol s
			 join file f on f.file_key = s.file_key
			 left join symbol parent on parent.symbol_key = s.enclosing_symbol_key
			 where s.generation_key = (select generation_key from generation where id = ?)
			 and s.id in (${placeholders(symbolIds.length)})`,
		)
		.all(generationId, ...symbolIds);
	const contexts = symbolContextsForRows(reader, generationId, symbolIds);

	return new Map(rows.map((row) => [asString(row, 'symbol_id'), toSymbolSummary(row, contexts.get(asString(row, 'symbol_id')) ?? [])]));
};

/** One external alias group keyed by the module target and imported name. */
export type ExternalAliasGroupType = Readonly<{
	readonly externalTarget: string;
	readonly externalName: string;
	readonly members: readonly SymbolSummaryType[];
}>;

/**
 * Reads the external alias group that contains one symbol.
 *
 * Members are every stored symbol with the same `(externalTarget, externalName)`
 * pair under the selected adapter, in deterministic path order. The seed is
 * never fanned out and no occurrence is duplicated: callers query the returned
 * identifier set once.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolId - Seed symbol identifier.
 * @param adapter - Optional adapter filter; omitted searches every adapter.
 * @returns The group, or null when the seed is not an external alias.
 */
export const externalAliasGroup = (reader: DatabaseSync, generationId: string, symbolId: string, adapter?: string): ExternalAliasGroupType | null => {
	const seed = reader
		.prepare(
			`select external_target, external_name from symbol
			 where generation_key = (select generation_key from generation where id = ?) and id = ?`,
		)
		.get(generationId, symbolId);
	const externalTarget = seed === undefined ? null : asNullableString(seed, 'external_target');
	const externalName = seed === undefined ? null : asNullableString(seed, 'external_name');

	if (externalTarget === null || externalName === null) {
		return null;
	}

	const adapterClause = adapter === undefined ? '' : ' and s.adapter_id = ?';
	const ids = reader
		.prepare(
			`select s.id from symbol s
			 join file f on f.file_key = s.file_key
			 where s.generation_key = (select generation_key from generation where id = ?)
			 and s.external_target = ? and s.external_name = ?${adapterClause}
			 order by f.path, s.start_offset, s.id`,
		)
		.all(...(adapter === undefined ? [generationId, externalTarget, externalName] : [generationId, externalTarget, externalName, adapter]))
		.map((row) => asString(row, 'id'));
	const summaries = symbolSummariesByIds(reader, generationId, ids);
	const members = ids.map((id) => summaries.get(id)).filter((member): member is SymbolSummaryType => member !== undefined);

	return {externalTarget, externalName, members};
};

/**
 * Builds the lexical outline page statement used by the hot page path.
 *
 * Exported so benchmarks and plan tests explain the production statement
 * rather than a hand-maintained copy.
 *
 * @param kindCount - Number of kind filter parameters.
 * @returns The statement text.
 */
export const outlinePageQuerySql = (kindCount: number): string => {
	const kindParameters = Array.from({length: kindCount}, (_, index) => `?${String(index + 3)}`).join(', ');
	const kindClause = kindCount === 0 ? '' : ` and s.kind in (${kindParameters})`;
	const limitParameter = kindCount + 3;
	const offsetParameter = kindCount + 4;

	return `select s.id as symbol_id, d.start_offset as start_offset
			 from definition_site d
			 join symbol s on s.symbol_key = d.symbol_key
			 where d.generation_key = (select generation_key from generation where id = ?1)
			 and d.file_key = (
				select file_key from file
				where generation_key = (select generation_key from generation where id = ?1) and path = ?2)
			 and d.first_in_symbol = 1${kindClause}
			 order by d.start_offset, d.symbol_id_order
			 limit ?${String(limitParameter)} offset ?${String(offsetParameter)}`;
};

/**
 * Reads the path with the most symbols in one generation.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @returns The busiest path, or null for an empty generation.
 */
export const busiestSymbolPath = (reader: DatabaseSync, generationId: string): string | null => {
	const row = reader
		.prepare(
			`select f.path from symbol s
			 join file f on f.file_key = s.file_key
			 where s.generation_key = (select generation_key from generation where id = ?)
			 group by f.path order by count(*) desc, f.path asc limit 1`,
		)
		.get(generationId);

	return row === undefined ? null : asString(row, 'path');
};

/**
 * Reads the lexical outline for one path.
 *
 * Page membership and order are derived from `definition_site` in path order so
 * a deep page never materializes the whole file or scans the generation. Symbol
 * summaries, contexts, and sites are then loaded for the page only.
 *
 * @param reader - Reader connection.
 * @param input - Generation, path, kind filter, and page bounds.
 * @returns Outline symbols and path-local definition sites.
 */
export const outlineSymbols = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; path: string; kinds: readonly string[]; limit: number; offset: number}>,
): readonly {symbol: SymbolSummaryType; site: DefinitionSiteSummaryType}[] => {
	const pageRows = reader.prepare(outlinePageQuerySql(input.kinds.length)).all(input.generationId, input.path, ...input.kinds, input.limit, input.offset);

	if (pageRows.length === 0) {
		return [];
	}

	const symbolIds = pageRows.map((row) => asString(row, 'symbol_id'));
	const summaries = symbolSummariesByIds(reader, input.generationId, symbolIds);
	const sitesBySymbol = definitionSitesForSymbols(reader, {generationId: input.generationId, symbolIds});
	const items: {symbol: SymbolSummaryType; site: DefinitionSiteSummaryType}[] = [];

	for (const pageRow of pageRows) {
		const symbolId = asString(pageRow, 'symbol_id');
		const symbol = summaries.get(symbolId);
		const sites = sitesBySymbol.get(symbolId) ?? [];
		const startOffset = asNumber(pageRow, 'start_offset');
		const site = sites.find((entry) => entry.path === input.path && entry.nameStart === startOffset) ?? sites.find((entry) => entry.path === input.path);

		if (symbol === undefined || site === undefined) {
			continue;
		}

		items.push({
			symbol: {...symbol, startOffset: site.nameStart, endOffset: site.nameEnd},
			site,
		});
	}

	return items;
};

/**
 * Reads re-exported and aliased bindings introduced in one path.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param pathName - Workspace-relative file path.
 * @returns Re-export entries with wildcard clauses collapsed.
 */
export const outlineReexports = (reader: DatabaseSync, generationId: string, pathName: string): readonly OutlineReexportType[] => {
	const rows = reader
		.prepare(
			`select n.binding_id, s.id as symbol_id, n.adapter_id, n.name, n.qualified_name, site.kind, f.path, site.start_offset, site.end_offset
			 from symbol_name_site site
			 join symbol_name n on n.symbol_name_key = site.symbol_name_key
			 join symbol s on s.symbol_key = n.symbol_key
			 join file f on f.file_key = site.file_key
			 where n.generation_key = (select generation_key from generation where id = ?)
			 and f.path = ? and site.kind in ('alias', 'default', 'reexport', 'wildcard')
			 order by f.path, site.start_offset, n.name`,
		)
		.all(generationId, pathName);
	const entries = new Map<string, OutlineReexportType>();

	for (const row of rows) {
		const kind = siteKindOf(asString(row, 'kind'));

		if (kind === 'wildcard') {
			const key = `wildcard:${String(asNumber(row, 'start_offset'))}`;
			const existing = entries.get(key);

			if (existing !== undefined) {
				entries.set(key, {...existing, wildcardCount: existing.wildcardCount + 1});
			} else {
				entries.set(key, {
					bindingId: '',
					symbolId: '',
					name: '*',
					qualifiedName: '*',
					adapter: asString(row, 'adapter_id'),
					path: asString(row, 'path'),
					start: asNumber(row, 'start_offset'),
					end: asNumber(row, 'end_offset'),
					kinds: ['wildcard'],
					wildcardCount: 1,
				});
			}

			continue;
		}

		const bindingId = asString(row, 'binding_id');
		const existing = entries.get(bindingId);

		entries.set(bindingId, {
			bindingId,
			symbolId: asString(row, 'symbol_id'),
			name: asString(row, 'name'),
			qualifiedName: asString(row, 'qualified_name'),
			adapter: asString(row, 'adapter_id'),
			path: asString(row, 'path'),
			start: asNumber(row, 'start_offset'),
			end: asNumber(row, 'end_offset'),
			kinds: existing === undefined ? [kind] : [...new Set([...existing.kinds, kind])],
			wildcardCount: 0,
		});
	}

	return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path) || left.start - right.start || left.name.localeCompare(right.name));
};

/**
 * Reads definition candidates whose extent contains a source position.
 *
 * @param reader - Reader connection.
 * @param input - Generation, path, line, and optional column.
 * @returns Innermost candidate definitions.
 */
export const symbolsAtPosition = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; path: string; line: number; column: number | null}>,
): readonly {symbol: SymbolSummaryType; site: DefinitionSiteSummaryType}[] => {
	const lineStartsRow = reader
		.prepare(
			`select content.line_starts from file join content on content.sha256 = file.content_sha256
			 where file.generation_key = (select generation_key from generation where id = ?) and file.path = ?`,
		)
		.get(input.generationId, input.path);

	if (lineStartsRow === undefined) {
		return [];
	}

	const starts = LineStartSchema.safeParse(JSON.parse(asString(lineStartsRow, 'line_starts')));

	if (!starts.success) {
		return [];
	}

	const lineStart = starts.data[input.line - 1];

	if (typeof lineStart !== 'number') {
		return [];
	}

	const nextLineStart = starts.data[input.line];
	const lineEnd = typeof nextLineStart === 'number' ? nextLineStart - 1 : Number.MAX_SAFE_INTEGER;
	const offset = input.column === null ? lineStart : lineStart + input.column - 1;
	const rows = reader
		.prepare(
			`select s.id, s.name, s.qualified_name, s.kind, s.adapter_id, f.path, s.start_line, s.start_column, s.end_line, s.end_column,
				parent.id as enclosing_id, d.site_id, o.start_offset, o.end_offset, o.extent_start, o.extent_end, o.start_line, o.end_line, o.declaration_kind,
				o.forward_definition
			 from occurrence o
			 join symbol s on s.symbol_key = o.symbol_key
			 join file f on f.file_key = o.file_key
			 left join symbol parent on parent.symbol_key = s.enclosing_symbol_key
			 join definition_site d on d.occurrence_key = o.occurrence_key
			 where o.generation_key = (select generation_key from generation where id = ?)
			 and f.path = ? and o.role = 'definition'
			 and o.extent_start <= ? and o.extent_end >= ?
			 order by (o.extent_end - o.extent_start) asc, o.start_offset asc, s.id`,
		)
		.all(input.generationId, input.path, input.column === null ? lineEnd : offset, input.column === null ? lineStart : offset);

	return rows.map((row) => ({
		symbol: toSymbolSummary({...row, symbol_id: asString(row, 'id')}, []),
		site: {
			siteId: asString(row, 'site_id'),
			path: input.path,
			nameStart: asNumber(row, 'start_offset'),
			nameEnd: asNumber(row, 'end_offset'),
			extentStart: asNumber(row, 'extent_start'),
			extentEnd: asNumber(row, 'extent_end'),
			startLine: asNumber(row, 'start_line'),
			endLine: asNumber(row, 'end_line'),
			declarationKind: asString(row, 'declaration_kind'),
			forwardDefinition: asNumber(row, 'forward_definition') === 1,
			primary: true,
			identityAnchor: true,
		},
	}));
};

/**
 * Reads one symbol summary by identifier.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolId - Symbol identifier.
 * @returns The symbol summary, or null.
 */
export const symbolSummaryById = (reader: DatabaseSync, generationId: string, symbolId: string): SymbolSummaryType | null => {
	const row = reader
		.prepare(
			`select s.id as symbol_id, s.name, s.qualified_name, s.kind, s.adapter_id, f.path, s.start_line, s.start_column,
				s.end_line, s.end_column, s.start_offset, s.end_offset, parent.id as enclosing_id, s.external_target, s.external_name
			 from symbol s
			 join file f on f.file_key = s.file_key
			 left join symbol parent on parent.symbol_key = s.enclosing_symbol_key
			 where s.generation_key = (select generation_key from generation where id = ?) and s.id = ?`,
		)
		.get(generationId, symbolId);

	if (row === undefined) {
		return null;
	}

	const contexts = symbolContextsForRows(reader, generationId, [symbolId]);
	return toSymbolSummary(row, contexts.get(symbolId) ?? []);
};

/**
 * Reads lexical ancestors for one symbol.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolId - Symbol identifier.
 * @returns Enclosing symbols from nearest to outermost.
 */
export const symbolAncestors = (reader: DatabaseSync, generationId: string, symbolId: string): readonly SymbolSummaryType[] => {
	const ancestors: SymbolSummaryType[] = [];
	let current = symbolSummaryById(reader, generationId, symbolId)?.enclosingId ?? null;
	const seen = new Set<string>();

	while (current !== null && !seen.has(current)) {
		seen.add(current);
		const symbol = symbolSummaryById(reader, generationId, current);

		if (symbol === null) {
			break;
		}

		ancestors.push(symbol);
		current = symbol.enclosingId;
	}

	return ancestors;
};

/**
 * Reads one definition site that belongs to a symbol.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolId - Symbol identifier.
 * @param siteId - Definition site identifier.
 * @returns The site, or null.
 */
export const definitionSiteById = (reader: DatabaseSync, generationId: string, symbolId: string, siteId: string): DefinitionSiteSummaryType | null => {
	const site = definitionSitesForSymbols(reader, {generationId, symbolIds: [symbolId]})
		.get(symbolId)
		?.find((entry) => entry.siteId === siteId);

	return site ?? null;
};

/**
 * Reads every definition site for one symbol.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolId - Symbol identifier.
 * @returns Definition sites in primary order.
 */
export const definitionSitesForSymbol = (reader: DatabaseSync, generationId: string, symbolId: string): readonly DefinitionSiteSummaryType[] =>
	definitionSitesForSymbols(reader, {generationId, symbolIds: [symbolId]}).get(symbolId) ?? [];
