import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {type DatabaseSync} from 'node:sqlite';
import {type VcsKindType, type VcsProvenanceType, type WorkingCopyIdentityType} from '../model.ts';
import {toRepositoryPath} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {asString} from './databaseRows.ts';
import {SCHEMA_VERSION} from './schema.ts';

const debug = debugFor('database');

export type DatabaseOpenContextType = Readonly<{
	rootDir?: string;
	projectFilePath?: string;
	projectId?: string;
	extractorId?: string;
	compilerVersion?: string;
	extractorVersion?: string;
	/**
	 * Serializable provenance read by the composition root. Undefined preserves
	 * the recorded provenance, so inner database opens never need a VCS adapter.
	 */
	vcs?: VcsProvenanceType | undefined;
}>;

const NONE_VCS: VcsProvenanceType = {kind: 'none', repository: null, revision: null, relativeRoot: null};

const vcsKindOf = (value: unknown): VcsKindType => (value === 'git' || value === 'svn' ? value : 'none');

export const readWorkingCopy = (reader: DatabaseSync): WorkingCopyIdentityType | null => {
	const row = reader.prepare('select * from working_copy limit 1').get();

	if (row === undefined) {
		return null;
	}

	return {
		id: asString(row, 'id'),
		canonicalRoot: asString(row, 'canonical_root'),
		vcs: {
			kind: vcsKindOf(row['vcs_kind']),
			repository: typeof row['vcs_repository'] === 'string' ? row['vcs_repository'] : null,
			revision: typeof row['vcs_revision'] === 'string' ? row['vcs_revision'] : null,
			relativeRoot: typeof row['vcs_relative_root'] === 'string' ? row['vcs_relative_root'] : null,
		},
		createdAt: asString(row, 'created_at'),
		lastSeenAt: asString(row, 'last_seen_at'),
	};
};

/**
 * Ensures the database records the expected schema version.
 *
 * @param writer - Writer connection.
 * @throws {Error} When a different schema version is already recorded.
 */
export const ensureMetadata = (writer: DatabaseSync): void => {
	const currentVersion = writer.prepare("select value from metadata where key = 'schema_version'").get();

	if (currentVersion === undefined) {
		debug('initializing schema', {schemaVersion: SCHEMA_VERSION});
		writer.prepare("insert into metadata (key, value) values ('schema_version', ?)").run(SCHEMA_VERSION);
		return;
	}

	if (asString(currentVersion, 'value') !== SCHEMA_VERSION) {
		debug('schema version mismatch', {expected: SCHEMA_VERSION, actual: asString(currentVersion, 'value')});
		throw new Error(`Unsupported index schema version; expected ${SCHEMA_VERSION}`);
	}
};

/**
 * Creates or refreshes the persistent working-copy and project identity.
 *
 * @param input - Writer and reader connections plus resolved project context.
 */
export const ensureIdentity = (
	input: Readonly<{
		writer: DatabaseSync;
		reader: DatabaseSync;
		context: DatabaseOpenContextType;
	}>,
): void => {
	const {writer, reader, context} = input;
	// Persist only workspace-relative paths. The opaque working-copy identifier
	// carries identity; the root itself is always the relative marker.
	const canonicalRoot = '.';
	const now = new Date().toISOString();
	const existing = reader.prepare('select * from working_copy limit 1').get();

	if (existing === undefined) {
		const vcs = context.vcs ?? NONE_VCS;
		writer
			.prepare(
				`insert into working_copy (id, canonical_root, vcs_kind, vcs_repository, vcs_revision, vcs_relative_root, created_at, last_seen_at)
				 values (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(randomUUID(), canonicalRoot, vcs.kind, vcs.repository, vcs.revision, vcs.relativeRoot, now, now);
	} else if (context.vcs === undefined) {
		writer.prepare('update working_copy set canonical_root = ?, last_seen_at = ? where id = ?').run(canonicalRoot, now, asString(existing, 'id'));
	} else {
		writer
			.prepare(
				`update working_copy
				 set canonical_root = ?, vcs_kind = ?, vcs_repository = coalesce(?, vcs_repository),
				     vcs_revision = ?, vcs_relative_root = coalesce(?, vcs_relative_root),
				     last_seen_at = ?
				 where id = ?`,
			)
			.run(canonicalRoot, context.vcs.kind, context.vcs.repository, context.vcs.revision, context.vcs.relativeRoot, now, asString(existing, 'id'));
	}

	const workingCopy = reader.prepare('select * from working_copy limit 1').get();
	const projectFile =
		context.projectFilePath === undefined
			? null
			: context.rootDir === undefined
				? path.isAbsolute(context.projectFilePath)
					? path.basename(context.projectFilePath)
					: context.projectFilePath
				: toRepositoryPath(context.rootDir, context.projectFilePath);

	if (workingCopy === undefined || projectFile === null) {
		return;
	}

	writer
		.prepare(
			`insert into indexed_project (id, working_copy_id, project_file, compiler_version, extractor_id, extractor_version, created_at)
			 values (?, ?, ?, ?, ?, ?, ?)
			 on conflict(working_copy_id, project_file) do update set
			 	compiler_version = excluded.compiler_version,
			 	extractor_id = excluded.extractor_id,
			 	extractor_version = excluded.extractor_version`,
		)
		.run(
			context.projectId ?? 'default',
			asString(workingCopy, 'id'),
			projectFile,
			context.compilerVersion ?? 'unknown',
			context.extractorId ?? 'unknown',
			context.extractorVersion ?? 'unknown',
			now,
		);
};
