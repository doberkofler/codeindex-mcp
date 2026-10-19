import {type DatabaseSync} from 'node:sqlite';
import {type BuildLeaseType} from '../model.ts';
import {asNumber, asString} from './databaseRows.ts';
import {transaction} from './databaseTransaction.ts';

/** Default lifetime of one build lease. */
export const BUILD_LEASE_TTL_MS = 10_000;

/** Short wait used by opportunistic heartbeat renewal. */
const LEASE_RENEW_BUSY_TIMEOUT_MS = 250;

const toLease = (row: Readonly<Record<string, unknown>>): BuildLeaseType => ({
	projectId: asString(row, 'project_id'),
	ownerId: asString(row, 'owner_id'),
	processId: asNumber(row, 'process_id'),
	acquiredAt: asString(row, 'acquired_at'),
	heartbeatAt: asString(row, 'heartbeat_at'),
	expiresAt: asString(row, 'expires_at'),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

const sqliteErrcode = (error: unknown): number | null => {
	if (!isRecord(error)) {
		return null;
	}

	const code = error['errcode'];
	return typeof code === 'number' ? code : null;
};

const isBusyOrLocked = (error: unknown): boolean => {
	const code = sqliteErrcode(error);
	return code !== null && ((code & 255) === 5 || (code & 255) === 6);
};

const writeHeartbeat = (writer: DatabaseSync, input: Readonly<{projectId: string; ownerId: string; ttlMs: number}>): boolean => {
	const now = Date.now();
	const result = writer
		.prepare('update build_lease set heartbeat_at = ?, expires_at = ? where project_id = ? and owner_id = ?')
		.run(new Date(now).toISOString(), new Date(now + input.ttlMs).toISOString(), input.projectId, input.ownerId);

	return Number(result.changes) > 0;
};

const withBusyTimeout = <ValueType>(writer: DatabaseSync, busyTimeoutMs: number, action: () => ValueType): ValueType => {
	const current = writer.prepare('pragma busy_timeout').get();
	const previousTimeoutMs = current === undefined ? 5000 : asNumber(current, 'timeout');

	writer.exec(`pragma busy_timeout = ${String(busyTimeoutMs)}`);

	try {
		return action();
	} finally {
		writer.exec(`pragma busy_timeout = ${String(previousTimeoutMs)}`);
	}
};

export const readLease = (reader: DatabaseSync, projectId: string): BuildLeaseType | null => {
	const row = reader.prepare('select * from build_lease where project_id = ?').get(projectId);
	return row === undefined ? null : toLease(row);
};

/**
 * Acquires or renews the single build lease.
 *
 * @param writer - Writer connection.
 * @param input - Project, owner, process, and lease lifetime.
 * @returns True when this owner may build.
 */
export const acquireLease = (writer: DatabaseSync, input: Readonly<{projectId: string; ownerId: string; processId: number; ttlMs: number}>): boolean => {
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const expiresAt = new Date(now + input.ttlMs).toISOString();
	let acquired = false;

	transaction(writer, () => {
		const existing = writer.prepare('select * from build_lease where project_id = ?').get(input.projectId);

		if (existing !== undefined && asString(existing, 'owner_id') !== input.ownerId && Date.parse(asString(existing, 'expires_at')) > now) {
			return;
		}

		const acquiredAt = existing === undefined || asString(existing, 'owner_id') !== input.ownerId ? nowIso : asString(existing, 'acquired_at');
		writer
			.prepare(
				`insert into build_lease (project_id, owner_id, process_id, acquired_at, heartbeat_at, expires_at)
				 values (?, ?, ?, ?, ?, ?)
				 on conflict(project_id) do update set
				 	owner_id = excluded.owner_id,
				 	process_id = excluded.process_id,
				 	acquired_at = excluded.acquired_at,
				 	heartbeat_at = excluded.heartbeat_at,
				 	expires_at = excluded.expires_at`,
			)
			.run(input.projectId, input.ownerId, input.processId, acquiredAt, nowIso, expiresAt);
		acquired = true;
	});

	return acquired;
};

/**
 * Opportunistically renews the lease without blocking the caller.
 *
 * A concurrent long write transaction makes the update fail with
 * `SQLITE_BUSY`. That is not a lost lease: the owner still holds the row, and
 * publication renews or verifies it inside the publication transaction.
 *
 * @param writer - Writer connection.
 * @param input - Project, owner, and lease lifetime.
 * @returns True when the heartbeat was written.
 */
export const renewLease = (writer: DatabaseSync, input: Readonly<{projectId: string; ownerId: string; ttlMs: number}>): boolean => {
	try {
		return withBusyTimeout(writer, LEASE_RENEW_BUSY_TIMEOUT_MS, () => writeHeartbeat(writer, input));
	} catch (error) {
		if (isBusyOrLocked(error)) {
			return false;
		}

		throw error;
	}
};

/**
 * Renews the lease inside the publication transaction.
 *
 * Renewal is allowed after the previous heartbeat expired as long as this owner
 * still owns the row. If another owner took over, publication must fail.
 *
 * @param writer - Writer connection.
 * @param input - Project, owner, and lease lifetime.
 * @returns True when this owner still owns the lease.
 */
export const renewLeaseStrict = (writer: DatabaseSync, input: Readonly<{projectId: string; ownerId: string; ttlMs: number}>): boolean =>
	writeHeartbeat(writer, input);

export const releaseLease = (writer: DatabaseSync, projectId: string, ownerId: string): void => {
	writer.prepare('delete from build_lease where project_id = ? and owner_id = ?').run(projectId, ownerId);
};
