import {type DatabaseSync} from 'node:sqlite';
import {type IndexedOccurrenceType, type IndexedSymbolType, type ScanProjectResultType} from '../model.ts';
import {asNumber, asString, placeholders} from './databaseRows.ts';

export const occurrenceContextKey = (path: string, startOffset: number, role: string): string => [path, String(startOffset), role].join('\u0000');

const appendContext = (groups: Map<string, string[]>, key: string, contextName: string): void => {
	const group = groups.get(key) ?? [];

	group.push(contextName);
	groups.set(key, group);
};

const sortedGroups = (groups: ReadonlyMap<string, readonly string[]>): ReadonlyMap<string, readonly string[]> =>
	new Map([...groups].map(([key, contexts]) => [key, [...new Set(contexts)].sort()]));

/**
 * Stores one row per configured project context.
 *
 * @param writer - Writer connection.
 * @param generationId - Candidate generation.
 * @param projects - Scanned project contexts.
 */
export const insertProjectContexts = (writer: DatabaseSync, generationId: string, projects: readonly ScanProjectResultType[]): void => {
	const statement = writer.prepare('insert into project_context (generation_id, name, project_file, config_hash) values (?, ?, ?, ?)');

	for (const project of projects) {
		statement.run(generationId, project.name, project.projectFile, project.configHash);
	}
};

/**
 * Associates declarations with the compiler contexts that produced them.
 *
 * @param writer - Writer connection.
 * @param generationId - Candidate generation.
 * @param symbols - Indexed declarations, optionally carrying contexts.
 */
export const insertSymbolContexts = (writer: DatabaseSync, generationId: string, symbols: readonly IndexedSymbolType[]): void => {
	const statement = writer.prepare('insert or ignore into symbol_context (generation_id, symbol_id, context_name) values (?, ?, ?)');

	for (const symbol of symbols) {
		for (const context of symbol.contexts ?? []) {
			statement.run(generationId, symbol.id, context);
		}
	}
};

/**
 * Associates occurrences with the compiler contexts that resolved them.
 *
 * @param writer - Writer connection.
 * @param generationId - Candidate generation.
 * @param occurrences - Indexed occurrences, optionally carrying contexts.
 */
export const insertOccurrenceContexts = (writer: DatabaseSync, generationId: string, occurrences: readonly IndexedOccurrenceType[]): void => {
	const statement = writer.prepare(
		`insert or ignore into occurrence_context (generation_id, symbol_id, path, start_offset, role, context_name)
		 values (?, ?, ?, ?, ?, ?)`,
	);

	for (const occurrence of occurrences) {
		for (const context of occurrence.contexts ?? []) {
			statement.run(generationId, occurrence.symbolId, occurrence.path, occurrence.startOffset, occurrence.role, context);
		}
	}
};

/**
 * Reads context names for a page of declarations.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolIds - Declaration identifiers in the page.
 * @returns Context names grouped by declaration identifier.
 */
export const listSymbolContexts = (reader: DatabaseSync, generationId: string, symbolIds: readonly string[]): ReadonlyMap<string, readonly string[]> => {
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
		appendContext(groups, asString(row, 'symbol_id'), asString(row, 'context_name'));
	}

	return sortedGroups(groups);
};

/**
 * Reads context names for one symbol's occurrences.
 *
 * @param reader - Reader connection.
 * @param input - Generation, symbol, and optional context filter.
 * @returns Context names grouped by occurrence key.
 */
export const listOccurrenceContexts = (
	reader: DatabaseSync,
	input: Readonly<{generationId: string; symbolId: string; context?: string | undefined}>,
): ReadonlyMap<string, readonly string[]> => {
	const contextClause = input.context === undefined ? '' : ' and context_name = ?';
	const parameters = input.context === undefined ? [input.generationId, input.symbolId] : [input.generationId, input.symbolId, input.context];
	const rows = reader
		.prepare(
			`select path, start_offset, role, context_name from occurrence_context
			 where generation_id = ? and symbol_id = ?${contextClause}
			 order by path, start_offset, role, context_name`,
		)
		.all(...parameters);
	const groups = new Map<string, string[]>();

	for (const row of rows) {
		appendContext(groups, occurrenceContextKey(asString(row, 'path'), asNumber(row, 'start_offset'), asString(row, 'role')), asString(row, 'context_name'));
	}

	return sortedGroups(groups);
};

/**
 * Lists the project contexts recorded for one generation.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @returns Project context names in insertion order.
 */
export const listProjectContextNames = (reader: DatabaseSync, generationId: string): readonly string[] =>
	reader
		.prepare('select name from project_context where generation_id = ? order by rowid')
		.all(generationId)
		.map((row) => asString(row, 'name'));
