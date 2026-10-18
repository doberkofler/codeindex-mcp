import {type DatabaseSync} from 'node:sqlite';
import {type GenerationRowType} from '../index/model.ts';
import {toGeneration} from './databaseRows.ts';

/**
 * Reads one generation by identifier.
 *
 * @param reader - Reader connection.
 * @param id - Generation identifier.
 * @returns The generation row, or null when absent.
 */
export const readGeneration = (reader: DatabaseSync, id: string): GenerationRowType | null => {
	const row = reader.prepare('select * from generation where id = ?').get(id);
	return row === undefined ? null : toGeneration(row);
};

/**
 * Reads the currently published generation.
 *
 * @param reader - Reader connection.
 * @returns The published generation, or null when none is published.
 */
export const readPublishedGeneration = (reader: DatabaseSync): GenerationRowType | null => {
	const row = reader
		.prepare(
			`select g.* from generation g
			 join metadata m on m.value = g.id
			 where m.key = 'current_generation' and g.state = 'published'`,
		)
		.get();

	return row === undefined ? null : toGeneration(row);
};

/**
 * Finds a published generation with matching source and configuration hashes.
 *
 * @param reader - Reader connection.
 * @param sourceHash - Source-set hash.
 * @param configHash - Configuration hash.
 * @returns The reusable generation, or null.
 */
export const findReusableGeneration = (reader: DatabaseSync, sourceHash: string, configHash: string): GenerationRowType | null => {
	const row = reader
		.prepare("select * from generation where state = 'published' and source_hash = ? and config_hash = ? order by completed_at desc limit 1")
		.get(sourceHash, configHash);

	return row === undefined ? null : toGeneration(row);
};
