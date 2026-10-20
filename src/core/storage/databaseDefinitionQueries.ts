import {type DatabaseSync} from 'node:sqlite';
import {type BindingExposureType, type DefinitionSiteSummaryType, type OutlineReexportType, type SymbolSummaryType} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';
import {EXPOSURE_ORDER, exposureOf, LineStartSchema, siteKindOf, toSymbolSummary} from './databasePublicationRows.ts';
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
			`select d.site_id, d.symbol_id, d.path, o.start_offset, o.end_offset, o.start_line, o.start_column, o.end_line, o.end_column,
				o.declaration_kind, o.forward_definition, o.primary_rank, o.anchor_rank, o.extent_start, o.extent_end
			 from definition_site d
			 join occurrence o on o.generation_id = d.generation_id and o.symbol_id = d.symbol_id and o.path = d.path and o.start_offset = d.start_offset and o.role = 'definition'
			 where d.generation_id = ? and d.symbol_id in (${placeholders(input.symbolIds.length)})
			 order by d.symbol_id, o.primary_rank, d.path, d.start_offset, o.end_offset`,
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
 * Reads the lexical outline for one path.
 *
 * @param reader - Reader connection.
 * @param input - Generation, path, kind filter, and page bounds.
 * @returns Outline symbols and path-local definition sites.
 */
export const outlineSymbols = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; path: string; kinds: readonly string[]; limit: number; offset: number}>,
): readonly {symbol: SymbolSummaryType; site: DefinitionSiteSummaryType}[] => {
	const kindClause = input.kinds.length === 0 ? '' : ` and s.kind in (${placeholders(input.kinds.length)})`;
	const rows = reader
		.prepare(
			`select s.id, s.name, s.qualified_name, s.kind, s.path, s.start_line, s.start_column, s.end_line, s.end_column,
				s.enclosing_id, s.exposure, d.site_id, o.start_offset, o.end_offset, o.start_line, o.end_line, o.declaration_kind, o.forward_definition,
				o.primary_rank, o.anchor_rank, o.extent_start, o.extent_end
			 from symbol s
			 join definition_site d on d.generation_id = s.generation_id and d.symbol_id = s.id
			 join occurrence o on o.generation_id = d.generation_id and o.symbol_id = d.symbol_id and o.path = d.path and o.start_offset = d.start_offset and o.role = 'definition'
			 where s.generation_id = ? and d.path = ?${kindClause}
			 group by s.id
			 order by min(o.start_offset), s.id
			 limit ? offset ?`,
		)
		.all(input.generationId, input.path, ...input.kinds, input.limit, input.offset);
	const symbolIds = rows.map((row) => asString(row, 'id'));
	const contexts = symbolContextsForRows(reader, input.generationId, symbolIds);
	const sitesBySymbol = definitionSitesForSymbols(reader, {generationId: input.generationId, symbolIds});

	return rows.map((row) => {
		const symbolId = asString(row, 'id');
		const selected = sitesBySymbol.get(symbolId)?.find((site) => site.path === input.path && site.nameStart === asNumber(row, 'start_offset'));

		return {
			symbol: toSymbolSummary({...row, symbol_id: symbolId}, contexts.get(symbolId) ?? []),
			site: selected ?? {
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
		};
	});
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
			`select n.binding_id, n.symbol_id, n.name, n.qualified_name, site.kind, site.path, site.start_offset, site.end_offset
			 from symbol_name_site site
			 join symbol_name n on n.generation_id = site.generation_id and n.binding_id = site.binding_id
			 where site.generation_id = ? and site.path = ? and site.kind in ('alias', 'default', 'reexport', 'wildcard')
			 order by site.path, site.start_offset, n.name`,
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
			 where file.generation_id = ? and file.path = ?`,
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
			`select s.id, s.name, s.qualified_name, s.kind, s.path, s.start_line, s.start_column, s.end_line, s.end_column,
				s.enclosing_id, d.site_id, o.start_offset, o.end_offset, o.extent_start, o.extent_end, o.start_line, o.end_line, o.declaration_kind,
				o.forward_definition
			 from occurrence o
			 join symbol s on s.generation_id = o.generation_id and s.id = o.symbol_id
			 join definition_site d on d.generation_id = o.generation_id and d.symbol_id = o.symbol_id and d.path = o.path and d.start_offset = o.start_offset and d.role = 'definition'
			 where o.generation_id = ? and o.path = ? and o.role = 'definition'
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
			`select id as symbol_id, name, qualified_name, kind, path, start_line, start_column, end_line, end_column, start_offset, end_offset, enclosing_id
			 from symbol where generation_id = ? and id = ?`,
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

/**
 * Validates that a binding belongs to a symbol.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolId - Symbol identifier.
 * @param bindingId - Binding identifier.
 * @returns True when the binding belongs to the symbol.
 */
export const bindingBelongsToSymbol = (reader: DatabaseSync, generationId: string, symbolId: string, bindingId: string): boolean => {
	const row = reader.prepare('select 1 from symbol_name where generation_id = ? and binding_id = ? and symbol_id = ?').get(generationId, bindingId, symbolId);

	return row !== undefined;
};

/**
 * Reads the effective exposure of one binding.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param bindingId - Binding identifier.
 * @param context - Optional context filter.
 * @returns The strongest exposure, or null.
 */
export const bindingExposure = (reader: DatabaseSync, generationId: string, bindingId: string, context?: string): BindingExposureType | null => {
	const row =
		context === undefined
			? reader
					.prepare(`select exposure from symbol_name_context where generation_id = ? and binding_id = ? order by ${EXPOSURE_ORDER} desc limit 1`)
					.get(generationId, bindingId)
			: reader
					.prepare('select exposure from symbol_name_context where generation_id = ? and binding_id = ? and context_name = ?')
					.get(generationId, bindingId, context);

	return row === undefined ? null : exposureOf(asString(row, 'exposure'));
};
