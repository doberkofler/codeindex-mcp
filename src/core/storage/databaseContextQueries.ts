import {type DatabaseSync} from 'node:sqlite';
import {type IndexedOccurrenceType, type IndexedSymbolType, type ScanProjectResultType} from '../model.ts';
import {asString} from './databaseRows.ts';

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
