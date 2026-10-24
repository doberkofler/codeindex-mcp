import {type DatabaseSync} from 'node:sqlite';

const STATISTICS_TABLE = 'sqlite_stat1';

/** One index that a hot query path depends on. */
export type PlannerStatisticRequirementType = Readonly<{
	readonly table: string;
	readonly index: string;
}>;

/**
 * Indexes whose row estimates the hot page statements depend on.
 *
 * Startup repairs a database that is missing any of these rows, not only a
 * database that is missing the whole `sqlite_stat1` table. Empty tables have no
 * statistics rows after `ANALYZE`, so each requirement is enforced only once
 * its table contains at least one row.
 */
export const REQUIRED_PLANNER_STATISTICS: readonly PlannerStatisticRequirementType[] = [
	{table: 'symbol_name', index: 'symbol_name_by_name'},
	{table: 'symbol_name', index: 'symbol_name_by_symbol'},
	{table: 'symbol_name_context', index: 'sqlite_autoindex_symbol_name_context_1'},
	{table: 'symbol_name_context', index: 'symbol_name_context_by_exposure'},
	{table: 'symbol_name_site', index: 'sqlite_autoindex_symbol_name_site_1'},
	{table: 'definition_site', index: 'definition_site_by_path'},
	{table: 'definition_site', index: 'definition_site_by_occurrence'},
	{table: 'occurrence', index: 'sqlite_autoindex_occurrence_1'},
	{table: 'occurrence_context', index: 'sqlite_autoindex_occurrence_context_1'},
	{table: 'symbol', index: 'sqlite_autoindex_symbol_1'},
];

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

const hasStatisticsTable = (reader: DatabaseSync): boolean =>
	reader.prepare('select 1 from sqlite_master where type = ? and name = ?').get('table', STATISTICS_TABLE) !== undefined;

const tableHasRows = (reader: DatabaseSync, table: string): boolean => reader.prepare(`select 1 from ${table} limit 1`).get() !== undefined;

const hasStatistic = (reader: DatabaseSync, table: string, index: string): boolean =>
	reader.prepare('select 1 from sqlite_stat1 where tbl = ? and idx = ?').get(table, index) !== undefined;

/**
 * Lists requirements whose table has rows but whose statistic row is absent.
 *
 * @param reader - Reader connection used to inspect the database.
 * @returns Missing planner statistics in declaration order.
 */
const missingPlannerStatistics = (reader: DatabaseSync): readonly PlannerStatisticRequirementType[] => {
	if (!hasStatisticsTable(reader)) {
		return REQUIRED_PLANNER_STATISTICS;
	}

	return REQUIRED_PLANNER_STATISTICS.filter(
		(requirement) => tableHasRows(reader, requirement.table) && !hasStatistic(reader, requirement.table, requirement.index),
	);
};

/**
 * Backfills planner statistics for a database that is missing required rows.
 *
 * @param reader - Reader connection used to detect existing statistics.
 * @param writer - Writer connection that records them.
 */
export const ensureStatistics = (reader: DatabaseSync, writer: DatabaseSync): void => {
	if (missingPlannerStatistics(reader).length > 0) {
		analyzeDatabase(writer);
	}
};
