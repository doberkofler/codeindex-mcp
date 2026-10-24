import {type DatabaseSync} from 'node:sqlite';
import {asString} from './databaseRows.ts';

/**
 * Verifies SQLite structural and foreign-key integrity.
 *
 * @param reader - Reader connection.
 * @throws {@link Error} When either pragma reports a failure.
 */
export const verifyDatabaseIntegrity = (reader: DatabaseSync): void => {
	const integrityFailures = reader
		.prepare('pragma integrity_check')
		.all()
		.filter((row) => asString(row, 'integrity_check') !== 'ok');

	if (integrityFailures.length > 0) {
		throw new Error('SQLite integrity check failed');
	}

	const foreignKeyFailures = reader.prepare('pragma foreign_key_check').all();

	if (foreignKeyFailures.length > 0) {
		throw new Error('SQLite foreign-key check failed');
	}
};
