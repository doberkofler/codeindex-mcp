import {DatabaseSync} from 'node:sqlite';
import {expect} from 'vitest';
import {IndexDatabase} from '../../src/core/storage/database.ts';
import {REQUIRED_PLANNER_STATISTICS} from '../../src/core/storage/databaseStatistics.ts';
import {type findSymbols} from '../../src/core/query/queryService.ts';
import {createGenerationFactSeed} from './generationFacts.ts';

/**
 * Reads one recorded planner statistic.
 *
 * @param databasePath - Index database file.
 * @param table - Table the statistic belongs to.
 * @param index - Index the statistic belongs to.
 * @returns The recorded `sqlite_stat1` value, or null when absent.
 */
export const statisticsOf = (databasePath: string, table: string, index: string): string | null => {
	const reader = new DatabaseSync(databasePath, {readOnly: true});

	try {
		const row = reader.prepare('select stat from sqlite_stat1 where tbl = ? and idx = ?').get(table, index);
		return row === undefined ? null : String(row['stat']);
	} finally {
		reader.close();
	}
};

/**
 * Asserts that every required statistic matches its table's current row count.
 *
 * @param databasePath - Index database file.
 */
export const assertCompleteStatistics = (databasePath: string): void => {
	const reader = new DatabaseSync(databasePath, {readOnly: true});

	try {
		const mismatches = REQUIRED_PLANNER_STATISTICS.flatMap((requirement) => {
			const countRow = reader.prepare(`select count(*) as total from ${requirement.table}`).get();
			const rowCount = countRow === undefined ? 0 : Number(countRow['total']);
			const statRow = reader.prepare('select stat from sqlite_stat1 where tbl = ? and idx = ?').get(requirement.table, requirement.index);
			const actual = statRow === undefined ? null : Number(String(statRow['stat']).split(' ')[0]);
			const expected = rowCount === 0 ? null : rowCount;

			return actual === expected ? [] : [{stage: `statistics.${requirement.table}.${requirement.index}`, expected, actual}];
		});

		expect(mismatches).toStrictEqual([]);
	} finally {
		reader.close();
	}
};

/**
 * Asserts that a plan neither scans a table nor builds a temporary B-tree.
 *
 * @param stage - Hot statement name used in the failure message.
 * @param plan - Flattened SQLite plan rows.
 */
export const assertIndexedPlan = (stage: string, plan: readonly string[]): void => {
	const problems = plan.filter((line) => line.startsWith('SCAN ') || line.includes('TEMP B-TREE')).map((line) => ({stage, line}));

	expect(problems).toStrictEqual([]);
};

/**
 * Publishes one synthetic generation through an already open database.
 *
 * @param database - Open index database.
 * @param id - Generation identifier.
 * @param symbolCount - Number of symbols to publish.
 * @param pathName - Workspace-relative source path.
 */
export const publishGeneration = (database: IndexDatabase, id: string, symbolCount: number, pathName = 'src/example.ts'): void => {
	database.createGeneration({
		id,
		extractorId: 'typescript',
		extractorVersion: '0.1.0',
		compilerVersion: '6.0.3',
		sourceHash: id,
		configHash: id,
	});
	database.insertGenerationFacts({generationId: id, ...createGenerationFactSeed({symbolCount, path: pathName})});
	database.publish(id);
};

/**
 * Opens a database, publishes one synthetic generation, and closes it.
 *
 * @param databasePath - Index database file.
 * @param id - Generation identifier.
 * @param symbolCount - Number of symbols to publish.
 * @param pathName - Workspace-relative source path.
 */
export const publishNewGeneration = (databasePath: string, id: string, symbolCount: number, pathName?: string): void => {
	const database = IndexDatabase.open(databasePath, {projectId: 'storage-test'});

	try {
		publishGeneration(database, id, symbolCount, pathName);
	} finally {
		database.close();
	}
};

/**
 * Builds the query context used by direct core query tests.
 *
 * @param database - Open index database.
 * @param generationId - Published generation identifier.
 * @returns A current-freshness query context.
 */
export const queryContextOf = (database: IndexDatabase, generationId: string): Parameters<typeof findSymbols>[0] => ({
	database,
	generationId,
	freshness: {state: 'current', checkedAt: '1970-01-01T00:00:00.000Z', dirtyFileCount: 0},
});
