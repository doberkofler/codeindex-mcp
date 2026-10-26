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
