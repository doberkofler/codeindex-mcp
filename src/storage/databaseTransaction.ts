import {type DatabaseSync} from 'node:sqlite';

/**
 * Runs one action inside an immediate SQLite transaction.
 *
 * @param database - Writer connection.
 * @param action - Work to commit.
 * @throws {Error} When the action fails; the transaction is rolled back.
 */
export const transaction = (database: DatabaseSync, action: () => void): void => {
	database.exec('begin immediate');

	try {
		action();
		database.exec('commit');
	} catch (error) {
		database.exec('rollback');
		throw error;
	}
};
