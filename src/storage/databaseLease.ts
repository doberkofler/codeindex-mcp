import {type DatabaseSync} from 'node:sqlite';
import {type BuildLeaseType} from '../index/model.ts';
import {asNumber, asString} from './databaseRows.ts';
import {transaction} from './databaseTransaction.ts';

const toLease = (row: Readonly<Record<string, unknown>>): BuildLeaseType => ({
	projectId: asString(row, 'project_id'),
	ownerId: asString(row, 'owner_id'),
	processId: asNumber(row, 'process_id'),
	acquiredAt: asString(row, 'acquired_at'),
	heartbeatAt: asString(row, 'heartbeat_at'),
	expiresAt: asString(row, 'expires_at'),
});

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

export const renewLease = (writer: DatabaseSync, input: Readonly<{projectId: string; ownerId: string; ttlMs: number}>): boolean => {
	const now = Date.now();
	const result = writer
		.prepare('update build_lease set heartbeat_at = ?, expires_at = ? where project_id = ? and owner_id = ?')
		.run(new Date(now).toISOString(), new Date(now + input.ttlMs).toISOString(), input.projectId, input.ownerId);

	return Number(result.changes) > 0;
};

export const releaseLease = (writer: DatabaseSync, projectId: string, ownerId: string): void => {
	writer.prepare('delete from build_lease where project_id = ? and owner_id = ?').run(projectId, ownerId);
};
