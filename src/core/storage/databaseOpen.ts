import {existsSync, mkdirSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {debugFor} from '../logging/debug.ts';
import {asString} from './databaseRows.ts';
import {SCHEMA_SQL, SCHEMA_VERSION} from './schema.ts';

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
const recreateIfIncompatible = (databasePath: string, expectedVersion: string): void => {
	if (databasePath === ':memory:' || !existsSync(databasePath)) {
		return;
	}

	const version = existingSchemaVersion(databasePath);

	if (version !== expectedVersion) {
		backupIncompatibleDatabase(databasePath, version);
	}
};

/**
 * Opens the writer and reader connections for one index database.
 *
 * Incompatible derived data is moved aside before the writer opens the file.
 *
 * @param databasePath - SQLite file path, or `:memory:` for a single connection.
 * @returns Writer and read-only connections to the current schema.
 */
export const openDatabaseConnections = (databasePath: string): Readonly<{writer: DatabaseSync; reader: DatabaseSync}> => {
	if (databasePath !== ':memory:') {
		mkdirSync(path.dirname(databasePath), {recursive: true});
		recreateIfIncompatible(databasePath, SCHEMA_VERSION);
	}

	const writer = new DatabaseSync(databasePath);

	writer.exec('pragma journal_mode = wal');
	writer.exec('pragma foreign_keys = on');
	writer.exec('pragma busy_timeout = 5000');
	writer.exec(SCHEMA_SQL);

	const reader = databasePath === ':memory:' ? writer : new DatabaseSync(databasePath, {readOnly: true});

	reader.exec('pragma foreign_keys = on');
	reader.exec('pragma busy_timeout = 5000');

	return {writer, reader};
};
