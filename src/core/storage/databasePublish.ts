import {type DatabaseSync} from 'node:sqlite';
import {debugFor} from '../logging/debug.ts';
import {assertPublicationLease} from './databaseCommit.ts';
import {checkpointAfterPublication} from './databaseCommitTelemetry.ts';
import {analyzeDatabase} from './databaseStatistics.ts';
import {transaction} from './databaseTransaction.ts';

const debug = debugFor('database');

/**
 * Publishes one explicitly created generation and supersedes the previous one.
 *
 * Retained for full rebuilds and storage tests; production refreshes use
 * in-place adapter commits.
 *
 * @param connection - Writer connection and build-lease project identity.
 * @param input - Generation to publish, optional counts, stages, and lease owner.
 * @returns Measured publication duration.
 * @throws {Error} When the lease was lost or expired before publication.
 */
export const publishNewGeneration = (
	connection: Readonly<{writer: DatabaseSync; projectId: string}>,
	input: Readonly<{
		generationId: string;
		diagnosticCount?: number;
		stages?: Readonly<{scanMs: number; compilerMs: number; extractionMs: number; insertionMs: number; verificationMs: number}>;
		ownerId?: string;
	}>,
): number => {
	const {writer} = connection;
	const {generationId, diagnosticCount, stages, ownerId} = input;
	const count = (table: string): number => {
		const row =
			table === 'dependency_binding'
				? writer
						.prepare(
							`select count(*) as total from dependency_binding b
							 join dependency_edge e on e.edge_key = b.edge_key
							 where e.generation_key = (select generation_key from generation where id = ?)`,
						)
						.get(generationId)
				: writer
						.prepare(`select count(*) as total from ${table} where generation_key = (select generation_key from generation where id = ?)`)
						.get(generationId);
		return row === undefined ? 0 : Number(row['total']);
	};
	const counts = {
		files: count('file'),
		symbols: count('symbol'),
		occurrences: count('occurrence'),
		dependencyEdges: count('dependency_edge'),
		dependencyBindings: count('dependency_binding'),
		diagnostics: diagnosticCount ?? count('diagnostic'),
	};
	debug('publish generation', {generationId, counts});
	const publicationStartedAt = performance.now();

	transaction(writer, () => {
		assertPublicationLease(connection, ownerId);

		writer.exec("delete from generation where state in ('superseded', 'failed')");
		writer
			.prepare(
				`update generation
				 set state = 'published', completed_at = ?, revision = revision + 1,
				     file_count = ?, symbol_count = ?, occurrence_count = ?,
				     dependency_edge_count = ?, dependency_binding_count = ?, diagnostic_count = ?,
				     scan_ms = ?, compiler_ms = ?, extraction_ms = ?, insertion_ms = ?, verification_ms = ?, publication_ms = ?
				 where id = ?`,
			)
			.run(
				new Date().toISOString(),
				counts.files,
				counts.symbols,
				counts.occurrences,
				counts.dependencyEdges,
				counts.dependencyBindings,
				counts.diagnostics,
				stages?.scanMs ?? null,
				stages?.compilerMs ?? null,
				stages?.extractionMs ?? null,
				stages?.insertionMs ?? null,
				stages?.verificationMs ?? null,
				null,
				generationId,
			);
		writer.prepare("update generation set state = 'superseded' where state = 'published' and id <> ?").run(generationId);
		writer
			.prepare("insert into metadata (key, value) values ('current_generation', ?) on conflict(key) do update set value = excluded.value")
			.run(generationId);
		writer.exec('delete from content where not exists (select 1 from file where file.content_sha256 = content.sha256)');
		analyzeDatabase(writer);
	});

	const publicationMs = Math.round(performance.now() - publicationStartedAt);
	writer.prepare('update generation set publication_ms = ? where id = ?').run(publicationMs, generationId);
	checkpointAfterPublication(writer);
	debug('generation published', {generationId, counts, publicationMs});
	return publicationMs;
};
