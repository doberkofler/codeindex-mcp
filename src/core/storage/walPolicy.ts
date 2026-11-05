/**
 * Declared write-ahead-log policy for every index database.
 *
 * SQLite may grow the WAL to the full write footprint of one publication while
 * a reader holds a snapshot. The durable bound is applied after a checkpoint,
 * so the declared limit and the benchmark/storage-audit budget use one formula.
 */

/** Pages written before SQLite attempts an automatic checkpoint. */
export const WAL_AUTOCHECKPOINT_PAGES = 1000;

/** Retained WAL after a checkpoint stays below this fraction of the database. */
const WAL_MAX_DATABASE_FRACTION = 0.1;

/** Floor that keeps tiny databases from declaring an unrealistically small bound. */
const WAL_MIN_SIZE_LIMIT_BYTES = 1024 * 1024;

/** Ceiling that keeps a large database from retaining an unbounded WAL. */
const WAL_MAX_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** Busy budget when a truncating checkpoint races a reader; a miss retries later. */
export const WAL_TRUNCATE_BUSY_TIMEOUT_MS = 100;

export type WalPolicyType = Readonly<{
	readonly autocheckpointPages: number;
	readonly maxDatabaseFraction: number;
	readonly minimumSizeLimitBytes: number;
	readonly maximumSizeLimitBytes: number;
}>;

/** Policy values reported by the storage audit. */
export const WAL_POLICY: WalPolicyType = {
	autocheckpointPages: WAL_AUTOCHECKPOINT_PAGES,
	maxDatabaseFraction: WAL_MAX_DATABASE_FRACTION,
	minimumSizeLimitBytes: WAL_MIN_SIZE_LIMIT_BYTES,
	maximumSizeLimitBytes: WAL_MAX_SIZE_LIMIT_BYTES,
};

/**
 * Computes the declared `journal_size_limit` for one database size.
 *
 * The limit is the smaller of the absolute ceiling and the larger of the floor
 * and the database-relative budget. A truncating checkpoint applies it; a
 * passive checkpoint that cannot complete leaves the WAL above the bound, which
 * the benchmark and storage audit report as a breach.
 *
 * @param databaseBytes - Main database file size in bytes.
 * @returns Maximum retained WAL bytes after a checkpoint.
 */
export const walSizeLimitBytes = (databaseBytes: number): number => {
	const proportional = Math.ceil(Math.max(0, databaseBytes) * WAL_MAX_DATABASE_FRACTION);

	return Math.min(WAL_MAX_SIZE_LIMIT_BYTES, Math.max(WAL_MIN_SIZE_LIMIT_BYTES, proportional));
};
