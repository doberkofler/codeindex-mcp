import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {type DatabaseSync} from 'node:sqlite';
import {type SourceFileType} from '../model.ts';
import {asNumber, asString} from './databaseRows.ts';
import {transaction} from './databaseTransaction.ts';

const sha256Of = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

const lineStartsOf = (content: string): readonly number[] => {
	const starts = [0];

	for (let index = 0; index < content.length; index += 1) {
		if (content[index] === '\n') {
			starts.push(index + 1);
		}
	}

	return starts;
};

/**
 * Inserts immutable content versions keyed by raw SHA-256.
 *
 * Identical bytes are stored once even when several paths reference them.
 *
 * @param writer - Writer connection.
 * @param files - Authored files to read and store.
 * @returns The number of content rows inserted.
 * @throws {Error} When a file changed between scan and insertion.
 */
export const insertContents = (writer: DatabaseSync, files: readonly SourceFileType[]): number => {
	let inserted = 0;
	const statement = writer.prepare(
		`insert or ignore into content (sha256, byte_count, line_count, encoding, line_starts, bytes)
		 values (?, ?, ?, 'utf8', ?, ?)`,
	);

	transaction(writer, () => {
		for (const file of files) {
			const bytes = readFileSync(file.absolutePath);
			const digest = sha256Of(bytes);

			if (digest !== file.sha256) {
				throw new Error(`Source changed during index build: ${file.path}`);
			}

			const content = bytes.toString('utf8');
			const result = statement.run(digest, bytes.byteLength, file.lineCount, JSON.stringify(lineStartsOf(content)), bytes);
			inserted += Number(result.changes);
		}
	});

	return inserted;
};

export type ExtractionArtifactKeyType = Readonly<{
	contentSha256: string;
	artifactKind: string;
	extractorId: string;
	extractorVersion: string;
	contextHash: string;
}>;

/**
 * Stores one extraction artifact keyed by content and extractor context.
 *
 * @param writer - Writer connection.
 * @param input - Artifact identity and serialized payload.
 */
export const putExtractionArtifact = (writer: DatabaseSync, input: ExtractionArtifactKeyType & Readonly<{artifactJson: string}>): void => {
	const now = new Date().toISOString();

	writer
		.prepare(
			`insert into extraction_artifact (content_sha256, artifact_kind, extractor_id, extractor_version, context_hash, artifact_json, created_at, last_used_at)
			 values (?, ?, ?, ?, ?, ?, ?, ?)
			 on conflict(content_sha256, artifact_kind, extractor_id, extractor_version, context_hash)
			 do nothing`,
		)
		.run(input.contentSha256, input.artifactKind, input.extractorId, input.extractorVersion, input.contextHash, input.artifactJson, now, now);
};

/**
 * Reports whether an extraction artifact already exists for one identity.
 *
 * @param reader - Reader connection.
 * @param input - Artifact identity.
 * @returns True when the artifact is stored.
 */
export const hasExtractionArtifact = (reader: DatabaseSync, input: ExtractionArtifactKeyType): boolean => {
	const row = reader
		.prepare(
			`select 1 as present from extraction_artifact
			 where content_sha256 = ? and artifact_kind = ? and extractor_id = ? and extractor_version = ? and context_hash = ?`,
		)
		.get(input.contentSha256, input.artifactKind, input.extractorId, input.extractorVersion, input.contextHash);

	return row !== undefined;
};

/**
 * Reads one extraction artifact payload.
 *
 * @param reader - Reader connection.
 * @param input - Artifact identity.
 * @returns The stored JSON, or null when the artifact is absent.
 */
export const getExtractionArtifact = (reader: DatabaseSync, input: ExtractionArtifactKeyType): string | null => {
	const row = reader
		.prepare(
			`select artifact_json from extraction_artifact
			 where content_sha256 = ? and artifact_kind = ? and extractor_id = ? and extractor_version = ? and context_hash = ?`,
		)
		.get(input.contentSha256, input.artifactKind, input.extractorId, input.extractorVersion, input.contextHash);

	return row === undefined ? null : asString(row, 'artifact_json');
};

export const countContentVersions = (reader: DatabaseSync): number => {
	const row = reader.prepare('select count(*) as total from content').get();
	return row === undefined ? 0 : asNumber(row, 'total');
};

/**
 * Counts occurrences for one symbol in a generation.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param symbolId - Symbol identifier.
 * @returns The occurrence count.
 */
export const countReferences = (reader: DatabaseSync, generationId: string, symbolId: string): number => {
	const row = reader.prepare('select count(*) as total from occurrence where generation_id = ? and symbol_id = ?').get(generationId, symbolId);
	return row === undefined ? 0 : asNumber(row, 'total');
};

/**
 * Lists immutable content hashes currently retained by the database.
 *
 * @param reader - Reader connection.
 * @returns Stored content hashes.
 */
export const listContentHashes = (reader: DatabaseSync): readonly string[] =>
	reader
		.prepare('select sha256 from content')
		.all()
		.map((row) => asString(row, 'sha256'));

/**
 * Counts stored extraction artifacts.
 *
 * @param reader - Reader connection.
 * @returns Artifact row count.
 */
export const countExtractionArtifacts = (reader: DatabaseSync): number => {
	const row = reader.prepare('select count(*) as total from extraction_artifact').get();
	return row === undefined ? 0 : asNumber(row, 'total');
};

/**
 * Reports the current SQLite file size in bytes.
 *
 * @param reader - Reader connection.
 * @returns Page count multiplied by page size.
 */
export const databaseSizeBytes = (reader: DatabaseSync): number => {
	const pageCount = reader.prepare('pragma page_count').get();
	const pageSize = reader.prepare('pragma page_size').get();
	return pageCount === undefined || pageSize === undefined ? 0 : asNumber(pageCount, 'page_count') * asNumber(pageSize, 'page_size');
};

/**
 * Reads one generation file and its content metadata.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param filePath - Repository-relative path.
 * @returns The file record, or null when it is not indexed.
 */
export const readFile = (reader: DatabaseSync, generationId: string, filePath: string): SourceFileType | null => {
	const row = reader
		.prepare(
			`select f.path, f.sha256, f.line_count, coalesce(c.byte_count, 0) as byte_count
			 from file f left join content c on c.sha256 = f.content_sha256
			 where f.generation_id = ? and f.path = ?`,
		)
		.get(generationId, filePath);

	if (row === undefined) {
		return null;
	}

	return {
		path: asString(row, 'path'),
		absolutePath: '',
		sha256: asString(row, 'sha256'),
		byteCount: asNumber(row, 'byte_count'),
		lineCount: asNumber(row, 'line_count'),
	};
};

/**
 * Lists the file identities in one generation.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @returns Paths and content hashes in path order.
 */
export const listFiles = (reader: DatabaseSync, generationId: string): readonly Readonly<{path: string; sha256: string}>[] =>
	reader
		.prepare('select path, sha256 from file where generation_id = ? order by path')
		.all(generationId)
		.map((row) => ({path: asString(row, 'path'), sha256: asString(row, 'sha256')}));
