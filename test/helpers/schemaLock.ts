import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

export type SchemaLockType = Readonly<{
	exit: Promise<unknown[]>;
}>;

/**
 * Holds an exclusive rollback-journal schema lock briefly.
 *
 * @param directory - Temporary directory for the child script.
 * @param databasePath - Initialized database to lock.
 * @returns Settlement of the lock holder.
 */
export const holdSchemaLock = async (directory: string, databasePath: string): Promise<SchemaLockType> => {
	const lockScript = path.join(directory, 'hold-schema-lock.mjs');

	writeFileSync(
		lockScript,
		`import {DatabaseSync} from 'node:sqlite';
const database = new DatabaseSync(${JSON.stringify(databasePath)});
database.exec('pragma journal_mode = delete; begin exclusive; create table schema_lock_probe (id integer)');
process.stdout.write('ready\\n');
setTimeout(() => {
	database.exec('rollback');
	database.close();
}, 250);
`,
	);
	const lockProcess = spawn(process.execPath, [lockScript], {stdio: ['ignore', 'pipe', 'pipe']});
	const exit = once(lockProcess, 'exit');

	await once(lockProcess.stdout, 'data');
	return {exit};
};
