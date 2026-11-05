import {existsSync, readdirSync, rmSync} from 'node:fs';
import path from 'node:path';

const {basename, dirname, join} = path;

const SCHEMA_BACKUP_MARKER = '.schema-';

const isSchemaBackup = (databaseName: string, fileName: string): boolean =>
	fileName.startsWith(`${databaseName}${SCHEMA_BACKUP_MARKER}`) && fileName.endsWith('.bak');

/**
 * Lists the schema recovery files of one index database.
 *
 * @param databasePath - Index database path.
 * @returns Absolute backup paths, newest name last.
 */
export const schemaBackupPaths = (databasePath: string): readonly string[] => {
	const directory = dirname(databasePath);
	const databaseName = basename(databasePath);

	try {
		return readdirSync(directory)
			.filter((name) => isSchemaBackup(databaseName, name))
			.map((name) => join(directory, name))
			.sort();
	} catch {
		return [];
	}
};

/**
 * Removes every schema recovery file except the newest recovery point.
 *
 * The caller invokes this only after an incompatible database has been moved
 * aside and the replacement database has passed its integrity check, so a
 * failed rebuild never deletes the recovery point it may need.
 *
 * @param databasePath - Index database path.
 * @param keepPath - Backup that must be retained, typically the current recovery point.
 * @returns Removed backup paths.
 */
export const pruneSchemaBackups = (databasePath: string, keepPath: string): readonly string[] => {
	const keep = path.resolve(keepPath);

	return schemaBackupPaths(databasePath)
		.filter((backupPath) => path.resolve(backupPath) !== keep && existsSync(backupPath))
		.map((backupPath) => {
			rmSync(backupPath, {force: true});
			return backupPath;
		});
};
