import {type DatabaseSync} from 'node:sqlite';

const STATISTICS_TABLE = 'sqlite_stat1';

/**
 * Refreshes SQLite query-planner statistics.
 *
 * Symbol search filters exposure through a correlated subquery over
 * `symbol_name_context`. Without statistics SQLite scans the whole generation
 * through `symbol_name_context_by_exposure` for every candidate row instead of
 * seeking `symbol_name_context` by `(generation_id, binding_id)`, which costs
 * seconds per page on a large index.
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
