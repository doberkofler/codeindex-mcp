import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {asString} from './databaseRows.ts';

/** Metadata key holding the fingerprint of the owning workspace root. */
const WORKSPACE_FINGERPRINT_KEY = 'workspace_fingerprint';

const BINDING_ERROR =
	'The index database belongs to a different working copy. Each checkout must use its own database: remove the CODE_INDEX_DATABASE or storage.database override for this checkout, or point it at a different database file.';

/**
 * Returns a non-reversible fingerprint of the canonical workspace root.
 *
 * The fingerprint binds one database to the checkout that created it without
 * persisting an absolute path.
 *
 * @param rootDir - Canonical workspace root, or undefined when the caller has none.
 * @returns 16-character fingerprint, or null when there is no root to bind.
 */
const workspaceFingerprintOf = (rootDir: string | undefined): string | null =>
	rootDir === undefined ? null : createHash('sha256').update(rootDir).digest('hex').slice(0, 16);

const fingerprintIn = (reader: DatabaseSync): string | null => {
	const row = reader.prepare('select value from metadata where key = ?').get(WORKSPACE_FINGERPRINT_KEY);
	return row === undefined ? null : asString(row, 'value');
};

/**
 * Reads a fingerprint without opening a writer connection.
 *
 * An unreadable or foreign file reports null: schema handling owns that case,
 * and cleanup must never be blocked by a file the tool cannot interpret.
 *
 * @param databasePath - SQLite file to probe.
 * @returns The stored fingerprint, or null when there is none to compare.
 */
const probeFingerprint = (databasePath: string): string | null => {
	if (!existsSync(databasePath)) {
		return null;
	}

	let database: DatabaseSync | undefined;

	try {
		database = new DatabaseSync(databasePath, {readOnly: true});
		return fingerprintIn(database);
	} catch {
		return null;
	} finally {
		database?.close();
	}
};

/**
 * Rejects a database that was created for another checkout.
 *
 * The probe runs before any writer connection opens, so a copied checkout that
 * shares a configured database path leaves the source database untouched.
 *
 * @param databasePath - SQLite file about to be opened.
 * @param rootDir - Canonical workspace root requesting the database.
 * @throws {@link Error} When the database is bound to a different root.
 */
export const assertWorkspaceBinding = (databasePath: string, rootDir: string | undefined): void => {
	const fingerprint = workspaceFingerprintOf(rootDir);

	if (fingerprint === null || databasePath === ':memory:') {
		return;
	}

	const stored = probeFingerprint(databasePath);

	if (stored !== null && stored !== fingerprint) {
		throw new Error(BINDING_ERROR);
	}
};

/**
 * Records the checkout that owns a database on first use.
 *
 * @param writer - Writer connection.
 * @param rootDir - Canonical workspace root.
 * @throws {@link Error} When the database is bound to a different root.
 */
export const ensureWorkspaceBinding = (writer: DatabaseSync, rootDir: string | undefined): void => {
	const fingerprint = workspaceFingerprintOf(rootDir);

	if (fingerprint === null) {
		return;
	}

	const stored = fingerprintIn(writer);

	if (stored === null) {
		writer.prepare('insert into metadata (key, value) values (?, ?)').run(WORKSPACE_FINGERPRINT_KEY, fingerprint);
		return;
	}

	if (stored !== fingerprint) {
		throw new Error(BINDING_ERROR);
	}
};
