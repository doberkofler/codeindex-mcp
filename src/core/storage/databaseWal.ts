import {type DatabaseSync} from 'node:sqlite';
import {asNumber, asString} from './databaseRows.ts';
import {WAL_AUTOCHECKPOINT_PAGES, WAL_TRUNCATE_BUSY_TIMEOUT_MS, walSizeLimitBytes} from './walPolicy.ts';

/** Checkpoint operation that produced the measured WAL state. */
type WalCheckpointModeType = 'none' | 'passive' | 'truncate';

/** Observed WAL state after one checkpoint attempt. */
export type WalCheckpointType = Readonly<{
	readonly mode: WalCheckpointModeType;
	readonly busy: boolean;
	readonly logFrames: number;
	readonly checkpointedFrames: number;
	readonly truncated: boolean;
}>;

type WalCheckpointRowType = Readonly<{busy: number; log: number; checkpointed: number}>;

const databaseSizeBytesOf = (writer: DatabaseSync): number => {
	const pageCount = writer.prepare('pragma page_count').get();
	const pageSize = writer.prepare('pragma page_size').get();

	return pageCount === undefined || pageSize === undefined ? 0 : asNumber(pageCount, 'page_count') * asNumber(pageSize, 'page_size');
};

const isWalMode = (writer: DatabaseSync): boolean => {
	const row = writer.prepare('pragma journal_mode').get();

	return row !== undefined && asString(row, 'journal_mode').toLowerCase() === 'wal';
};

const checkpointRowOf = (writer: DatabaseSync, mode: 'passive' | 'truncate'): WalCheckpointRowType => {
	const row = writer.prepare(`pragma wal_checkpoint(${mode})`).get();

	if (row === undefined) {
		return {busy: 0, log: 0, checkpointed: 0};
	}

	return {busy: asNumber(row, 'busy'), log: asNumber(row, 'log'), checkpointed: asNumber(row, 'checkpointed')};
};

/**
 * Applies the declared WAL policy to one writer connection.
 *
 * `journal_size_limit` and `wal_autocheckpoint` are connection settings, so
 * every writer must apply them after opening. The size limit follows the current
 * database size and is refreshed before each checkpoint.
 *
 * @param writer - Writer connection.
 * @param databaseBytes - Main database size; read from the connection when omitted.
 * @returns The applied `journal_size_limit`.
 */
export const applyWalPolicy = (writer: DatabaseSync, databaseBytes: number = databaseSizeBytesOf(writer)): number => {
	const sizeLimit = walSizeLimitBytes(databaseBytes);
	writer.exec(`pragma journal_size_limit = ${String(sizeLimit)}`);
	writer.exec(`pragma wal_autocheckpoint = ${String(WAL_AUTOCHECKPOINT_PAGES)}`);

	return sizeLimit;
};

const withBusyTimeout = <ValueType>(writer: DatabaseSync, timeoutMs: number, action: () => ValueType): ValueType => {
	const row = writer.prepare('pragma busy_timeout').get();
	const previous = row === undefined ? 5000 : asNumber(row, 'timeout');

	writer.exec(`pragma busy_timeout = ${String(timeoutMs)}`);

	try {
		return action();
	} finally {
		writer.exec(`pragma busy_timeout = ${String(previous)}`);
	}
};

/**
 * Checkpoints the WAL after publication.
 *
 * A passive checkpoint never blocks a reader. The WAL is truncated only when
 * the passive result shows that no reader pinned a frame; a truncating
 * checkpoint then has a short busy budget so a racing query is retried on the
 * next publication instead of stalling the transport.
 *
 * @param writer - Writer connection outside any transaction.
 * @returns The measured checkpoint state.
 */
export const checkpointWal = (writer: DatabaseSync): WalCheckpointType => {
	if (!isWalMode(writer)) {
		return {mode: 'none', busy: false, logFrames: 0, checkpointedFrames: 0, truncated: false};
	}

	applyWalPolicy(writer);
	const passive = checkpointRowOf(writer, 'passive');

	if (passive.busy !== 0 || passive.log !== passive.checkpointed) {
		return {mode: 'passive', busy: passive.busy !== 0, logFrames: passive.log, checkpointedFrames: passive.checkpointed, truncated: false};
	}

	const truncate = withBusyTimeout(writer, WAL_TRUNCATE_BUSY_TIMEOUT_MS, () => checkpointRowOf(writer, 'truncate'));

	return {
		mode: 'truncate',
		busy: truncate.busy !== 0,
		logFrames: truncate.log,
		checkpointedFrames: truncate.checkpointed,
		truncated: truncate.busy === 0 && truncate.log === truncate.checkpointed,
	};
};
