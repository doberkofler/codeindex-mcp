import {type DatabaseSync} from 'node:sqlite';

const STATISTICS_TABLE = 'sqlite_stat1';

/**
 * Refreshes SQLite query-planner statistics.
 *
 * Statistics keep range estimates for binding search, outline paging, and
 * reference joins accurate; without them SQLite can choose a whole-generation
 * index scan for a statement whose bound range it cannot estimate.
 *
 * @param writer - Writer connection.
 */
export const analyzeDatabase = (writer: DatabaseSync): void => {
	writer.exec('analyze');
};

/**
 * Backfills planner statistics for a database built before they were written.
 *
 * @param reader - Reader connection used to detect existing statistics.
 * @param writer - Writer connection that records them.
 */
export const ensureStatistics = (reader: DatabaseSync, writer: DatabaseSync): void => {
	const present = reader.prepare('select 1 from sqlite_master where type = ? and name = ?').get('table', STATISTICS_TABLE) !== undefined;

	if (!present) {
		analyzeDatabase(writer);
	}
};
