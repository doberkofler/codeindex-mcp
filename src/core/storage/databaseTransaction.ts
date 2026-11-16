import {type DatabaseSync} from 'node:sqlite';

/** Writer-lock wait and COMMIT time for one successful transaction. */
export type TransactionTimingType = Readonly<{
	readonly queueWaitMs: number;
	readonly commitMs: number;
}>;

/**
 * Runs one action inside an immediate transaction and measures lock/COMMIT time.
 *
 * @param database - Writer connection.
 * @param action - Work to commit.
 * @param beforeCommit - Optional final cancellation or ownership check.
 * @returns Exclusive queue-wait and COMMIT durations.
 * @throws {Error} When the action or COMMIT fails; the transaction is rolled back.
 */
export const timedTransaction = (database: DatabaseSync, action: () => void, beforeCommit?: () => void): TransactionTimingType => {
	const queueStartedAt = performance.now();
	database.exec('begin immediate');
	const queueWaitMs = Math.round(performance.now() - queueStartedAt);

	try {
		action();
		beforeCommit?.();
		const commitStartedAt = performance.now();
		database.exec('commit');
		return {queueWaitMs, commitMs: Math.round(performance.now() - commitStartedAt)};
	} catch (error) {
		database.exec('rollback');
		throw error;
	}
};

/**
 * Runs one action inside an immediate SQLite transaction.
 *
 * @param database - Writer connection.
 * @param action - Work to commit.
 * @throws {Error} When the action fails; the transaction is rolled back.
 */
export const transaction = (database: DatabaseSync, action: () => void): void => {
	timedTransaction(database, action);
};
