import {existsSync, renameSync, rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {debugFor} from '../logging/debug.ts';
import {asString} from './databaseRows.ts';

const debug = debugFor('database');

const existingSchemaVersion = (databasePath: string): string | null => {
	let database: DatabaseSync | undefined;

	try {
		database = new DatabaseSync(databasePath, {readOnly: true});
		const row = database.prepare("select value from metadata where key = 'schema_version'").get();
		return row === undefined ? null : asString(row, 'value');
	} catch {
		return null;
	} finally {
		database?.close();
	}
};

/**
 * Returns SQLite's chosen access path for one statement.
 *
 * @param reader - Reader connection.
 * @param sql - Statement to explain.
 * @param parameters - Bound parameters.
 * @returns The flattened query-plan detail rows.
 */
export const explainQueryPlan = (reader: DatabaseSync, sql: string, parameters: readonly (string | number)[] = []): readonly string[] =>
	reader
		.prepare(`explain query plan ${sql}`)
		.all(...parameters)
		.map((row) => asString(row, 'detail'));

/**
 * Moves an incompatible derived database aside before a clean rebuild.
 *
 * @param databasePath - Existing SQLite file.
 * @param version - Detected schema version, when readable.
 * @returns The backup path.
 */
const backupIncompatibleDatabase = (databasePath: string, version: string | null): string => {
	const backupPath = `${databasePath}.schema-${version ?? 'unknown'}.bak`;

	rmSync(backupPath, {force: true});
	renameSync(databasePath, backupPath);
	rmSync(`${databasePath}-wal`, {force: true});
	rmSync(`${databasePath}-shm`, {force: true});
	debug('incompatible schema backed up', {databasePath, backupPath, version});
	return backupPath;
};

/**
 * Recreates a database whose recorded schema version is not current.
 *
 * @param databasePath - SQLite file path.
 * @param expectedVersion - Required schema version.
 */
export const recreateIfIncompatible = (databasePath: string, expectedVersion: string): void => {
	if (databasePath === ':memory:' || !existsSync(databasePath)) {
		return;
	}

	const version = existingSchemaVersion(databasePath);

	if (version !== expectedVersion) {
		backupIncompatibleDatabase(databasePath, version);
	}
};
