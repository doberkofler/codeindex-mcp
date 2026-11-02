import {type DatabaseSync} from 'node:sqlite';
import {asString} from './databaseRows.ts';

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

/** One adapter-scoped project context in a published generation. */
export type ProjectContextEntryType = Readonly<{adapterId: string; name: string}>;

/**
 * Lists every adapter-scoped project context in one generation.
 *
 * Context names are not globally unique, so callers must resolve a bare name
 * against this list instead of the name set alone.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @returns Context entries in insertion order.
 */
export const listProjectContextEntries = (reader: DatabaseSync, generationId: string): readonly ProjectContextEntryType[] =>
	reader
		.prepare('select adapter_id, name from project_context where generation_id = ? order by rowid')
		.all(generationId)
		.map((row) => ({adapterId: asString(row, 'adapter_id'), name: asString(row, 'name')}));
