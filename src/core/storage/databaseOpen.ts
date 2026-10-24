import {existsSync, mkdirSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {debugFor} from '../logging/debug.ts';
import {asString} from './databaseRows.ts';
import {SCHEMA_SQL, SCHEMA_VERSION} from './schema.ts';
import {assertWorkspaceBinding} from './workspaceBinding.ts';

const debug = debugFor('database');

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;

const sqliteCodeOf = (error: unknown): number | null => {
	if (typeof error !== 'object' || error === null || !('errcode' in error)) {
		return null;
	}

	const {errcode} = error;
	return typeof errcode === 'number' ? errcode & 255 : null;
};

/**
 * Reports whether a failure to read the schema version concerns access, not content.
 *
 * A database that is busy, locked, unreadable, or on a failing volume carries no
 * information about its schema. Treating such a failure as an incompatible schema
 * would move a valid index aside and force a needless rebuild. Only content
 * failures — an empty file, a foreign file, or a corrupt page — are incompatible.
 *
 * @param error - Value thrown while reading the metadata table.
 * @returns True when the failure must propagate instead of triggering a rebuild.
 */
const isAccessFailure = (error: unknown): boolean => {
	const code = sqliteCodeOf(error);
	return code === SQLITE_BUSY || code === SQLITE_LOCKED || code === SQLITE_IOERR || code === SQLITE_FULL || code === SQLITE_CANTOPEN;
};

const existingSchemaVersion = (databasePath: string): string | null => {
	let database: DatabaseSync | undefined;

	try {
		database = new DatabaseSync(databasePath, {readOnly: true});
		const row = database.prepare("select value from metadata where key = 'schema_version'").get();
		return row === undefined ? null : asString(row, 'value');
	} catch (error) {
		if (isAccessFailure(error)) {
			throw error;
		}

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
 * A database bound to another checkout is rejected and incompatible derived
 * data is moved aside before the writer opens the file.
 *
 * @param databasePath - SQLite file path, or `:memory:` for a single connection.
 * @param rootDir - Canonical workspace root requesting the database.
 * @returns Writer and read-only connections to the current schema.
 * @throws {@link Error} When the database belongs to a different workspace root.
 */
export const openDatabaseConnections = (databasePath: string, rootDir?: string): Readonly<{writer: DatabaseSync; reader: DatabaseSync}> => {
	if (databasePath !== ':memory:') {
		mkdirSync(path.dirname(databasePath), {recursive: true});
		assertWorkspaceBinding(databasePath, rootDir);
		recreateIfIncompatible(databasePath, SCHEMA_VERSION);
	}

	const writer = new DatabaseSync(databasePath);

	writer.exec('pragma journal_mode = wal');
	writer.exec('pragma foreign_keys = on');
	writer.exec('pragma busy_timeout = 5000');
	writer.exec('pragma mmap_size = 1073741824');
	writer.exec('pragma cache_size = -32768');
	writer.exec(SCHEMA_SQL);

	const reader = databasePath === ':memory:' ? writer : new DatabaseSync(databasePath, {readOnly: true});

	reader.exec('pragma foreign_keys = on');
	reader.exec('pragma busy_timeout = 5000');
	reader.exec('pragma mmap_size = 1073741824');
	reader.exec('pragma cache_size = -32768');

	return {writer, reader};
};
