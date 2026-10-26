import {type DatabaseSync} from 'node:sqlite';

/**
 * Runs one read against a single WAL snapshot.
 *
 * A revision commits atomically, but a multi-statement query that reads the
 * reader connection without a transaction could observe rows from two
 * revisions. Starting one deferred read transaction pins every statement in
 * the action to the same snapshot.
 *
 * @param reader - Reader connection.
 * @param writer - Writer connection; identical to the reader for `:memory:`.
 * @param action - Read-only work over the reader connection.
 * @returns The action's value.
 * @throws {Error} Whatever the action throws; the snapshot is rolled back.
 */
export const readSnapshot = <ValueType>(reader: DatabaseSync, writer: DatabaseSync, action: () => ValueType): ValueType => {
	if (reader === writer) {
		return action();
	}

	reader.exec('begin');

	try {
		const value = action();
		reader.exec('commit');
		return value;
	} catch (error) {
		reader.exec('rollback');
		throw error;
	}
};
