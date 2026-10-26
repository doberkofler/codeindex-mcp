import {type DatabaseSync} from 'node:sqlite';
import {CodeIndexError} from '../errors/codeIndexError.ts';
import {type BuildStagesType} from '../model.ts';
import {debugFor} from '../logging/debug.ts';
import {writeContents} from './databaseContent.ts';
import {
	syncGenerationFiles,
	validateGenerationFacts,
	writeGenerationFacts,
	type GenerationFactWriteModeType,
	type GenerationFactsInputType,
} from './databaseFacts.ts';
import {BUILD_LEASE_TTL_MS, renewLeaseStrict} from './databaseLease.ts';
import {readGeneration} from './databaseRead.ts';
import {asString} from './databaseRows.ts';
import {analyzeDatabase} from './databaseStatistics.ts';
import {transaction} from './databaseTransaction.ts';

const debug = debugFor('database');

/** Refresh framing shared by a fact-writing commit and a fact-reuse commit. */
type GenerationCommitBaseType = Readonly<{
	/** `insert` creates the first published revision; `revise` updates it in place. */
	readonly mode: GenerationFactWriteModeType;
	readonly configHash: string;
	readonly stages: Readonly<{scanMs: number; compilerMs: number; extractionMs: number}>;
	readonly ownerId?: string;
}>;

/** One refresh committed against the stable published generation. */
export type GenerationCommitInputType = (
	| (GenerationFactsInputType & Readonly<{readonly reuseFacts: false}>)
	| Readonly<{
			readonly reuseFacts: true;
			readonly generationId: string;
			readonly files: GenerationFactsInputType['files'];
			readonly projects: GenerationFactsInputType['projects'];
			readonly sourceHash: string;
	  }>
) &
	GenerationCommitBaseType;

/** Persisted outcome of one refresh. */
export type GenerationCommitType = Readonly<{
	readonly generationId: string;
	readonly revision: number;
	readonly counts: Readonly<{
		readonly files: number;
		readonly symbols: number;
		readonly occurrences: number;
		readonly dependencyEdges: number;
		readonly dependencyBindings: number;
		readonly diagnostics: number;
	}>;
	readonly changedPaths: readonly string[];
	readonly writtenRows: number;
	readonly reusedFacts: boolean;
	readonly stages: BuildStagesType;
}>;

type CommitConnectionType = Readonly<{writer: DatabaseSync; projectId: string}>;

const insertPhase = (connection: CommitConnectionType, input: GenerationCommitInputType): ReturnType<typeof writeGenerationFacts> | null => {
	writeContents(connection.writer, input.files);

	if (input.reuseFacts) {
		syncGenerationFiles(connection.writer, input.generationId, input.files);
		return null;
	}

	return writeGenerationFacts(connection.writer, input, input.mode);
};

const verifyPhase = (writer: DatabaseSync, input: GenerationCommitInputType): void => {
	if (input.reuseFacts) {
		if (writer.prepare('pragma foreign_key_check').all().length > 0) {
			throw new Error('SQLite foreign-key check failed for the candidate generation');
		}
	} else {
		validateGenerationFacts(writer, input);
	}

	const quickCheck = writer.prepare('pragma quick_check').all();

	if (quickCheck.some((row) => asString(row, 'quick_check') !== 'ok')) {
		throw new Error('SQLite quick check failed for the candidate generation');
	}
};

const countsForCommit = (
	write: ReturnType<typeof writeGenerationFacts> | null,
	previous: Readonly<{
		fileCount: number;
		symbolCount: number;
		occurrenceCount: number;
		dependencyEdgeCount: number;
		dependencyBindingCount: number;
		diagnosticCount: number;
	}>,
): GenerationCommitType['counts'] => {
	const counts = write?.counts ?? null;

	return {
		files: counts?.files ?? previous.fileCount,
		symbols: counts?.symbols ?? previous.symbolCount,
		occurrences: counts?.occurrences ?? previous.occurrenceCount,
		dependencyEdges: counts?.dependencyEdges ?? previous.dependencyEdgeCount,
		dependencyBindings: counts?.dependencyBindings ?? previous.dependencyBindingCount,
		diagnostics: counts?.diagnostics ?? previous.diagnosticCount,
	};
};

const publishPhase = (
	connection: CommitConnectionType,
	input: GenerationCommitInputType,
	write: ReturnType<typeof writeGenerationFacts> | null,
	stages: Readonly<{insertionMs: number; verificationMs: number}>,
): GenerationCommitType => {
	const {writer} = connection;
	const previous = readGeneration(writer, input.generationId);

	if (previous === null) {
		throw new Error('Published generation disappeared before publication');
	}

	const countsFor = countsForCommit(write, previous);

	writer
		.prepare(
			`update generation
			 set state = 'published', completed_at = ?, revision = revision + 1, config_hash = ?,
			     file_count = ?, symbol_count = ?, occurrence_count = ?,
			     dependency_edge_count = ?, dependency_binding_count = ?, diagnostic_count = ?,
			     scan_ms = ?, compiler_ms = ?, extraction_ms = ?, insertion_ms = ?, verification_ms = ?, publication_ms = ?
			 where id = ?`,
		)
		.run(
			new Date().toISOString(),
			input.configHash,
			countsFor.files,
			countsFor.symbols,
			countsFor.occurrences,
			countsFor.dependencyEdges,
			countsFor.dependencyBindings,
			countsFor.diagnostics,
			input.stages.scanMs,
			input.stages.compilerMs,
			input.stages.extractionMs,
			stages.insertionMs,
			stages.verificationMs,
			null,
			input.generationId,
		);

	writer
		.prepare("insert into metadata (key, value) values ('current_generation', ?) on conflict(key) do update set value = excluded.value")
		.run(input.generationId);
	writer.exec('delete from content where not exists (select 1 from file where file.content_sha256 = content.sha256)');
	analyzeDatabase(writer);

	return {
		generationId: input.generationId,
		revision: previous.revision + 1,
		counts: countsFor,
		changedPaths: write?.changedPaths ?? [],
		writtenRows: write?.writtenRows ?? input.files.length,
		reusedFacts: input.reuseFacts,
		stages: {
			scanMs: input.stages.scanMs,
			compilerMs: input.stages.compilerMs,
			extractionMs: input.stages.extractionMs,
			insertionMs: stages.insertionMs,
			verificationMs: stages.verificationMs,
			// Measured below; the clock covers generation metadata and analysis.
			publicationMs: 0,
		},
	};
};

/**
 * Applies one refresh to the published generation in a single transaction.
 *
 * The published generation identifier is stable across successful refreshes.
 * Each commit increments its revision, replaces only the path groups whose
 * facts changed, validates the result, and refreshes planner statistics.
 * Readers on the WAL snapshot keep seeing the previous revision until commit;
 * a failure rolls the whole refresh back.
 *
 * @param connection - Writer connection and build-lease project identity.
 * @param input - Scan manifest, facts, stages, and optional lease owner.
 * @returns Measured stages, persisted counts, and written row groups.
 * @throws {@link CodeIndexError} When the build lease was lost.
 * @throws {Error} When validation fails; the transaction is rolled back.
 */
export const commitGeneration = (connection: CommitConnectionType, input: GenerationCommitInputType): GenerationCommitType => {
	const {writer, projectId} = connection;
	const outcome: {report: GenerationCommitType | null} = {report: null};
	let publicationMs = 0;

	transaction(writer, () => {
		// Row order is validated explicitly before commit; deferring the per-row
		// foreign-key lookups keeps bulk writes linear.
		writer.exec('pragma defer_foreign_keys = on');

		if (input.ownerId !== undefined && !renewLeaseStrict(writer, {projectId, ownerId: input.ownerId, ttlMs: BUILD_LEASE_TTL_MS})) {
			throw new CodeIndexError('index_build_failed', 'Build lease was lost or taken over before publication');
		}

		const insertionStartedAt = performance.now();
		const write = insertPhase(connection, input);
		const insertionMs = Math.round(performance.now() - insertionStartedAt);
		const verificationStartedAt = performance.now();
		verifyPhase(writer, input);
		const verificationMs = Math.round(performance.now() - verificationStartedAt);
		const publicationStartedAt = performance.now();
		const report = publishPhase(connection, input, write, {insertionMs, verificationMs});

		publicationMs = Math.round(performance.now() - publicationStartedAt);
		outcome.report = {...report, stages: {...report.stages, publicationMs}};
	});

	const {report} = outcome;

	if (report === null) {
		throw new Error('Generation commit did not complete');
	}

	writer.prepare('update generation set publication_ms = ? where id = ?').run(publicationMs, input.generationId);
	debug('generation committed', {generationId: input.generationId, revision: report.revision, changedPaths: report.changedPaths.length});
	return report;
};

/**
 * Publishes one explicitly created generation and supersedes the previous one.
 *
 * Retained for full rebuilds and storage tests; production refreshes use
 * {@link commitGeneration}, which revises the published generation in place.
 *
 * @param connection - Writer connection and build-lease project identity.
 * @param input - Generation to publish, optional counts, stages, and lease owner.
 * @returns Measured publication duration.
 * @throws {@link CodeIndexError} When the lease was lost or expired before publication.
 */
export const publishNewGeneration = (
	connection: CommitConnectionType,
	input: Readonly<{
		generationId: string;
		diagnosticCount?: number;
		stages?: Readonly<{scanMs: number; compilerMs: number; extractionMs: number; insertionMs: number; verificationMs: number}>;
		ownerId?: string;
	}>,
): number => {
	const {writer, projectId} = connection;
	const {generationId, diagnosticCount, stages, ownerId} = input;
	const count = (table: string): number => {
		const row = writer.prepare(`select count(*) as total from ${table} where generation_id = ?`).get(generationId);
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
		if (ownerId !== undefined && !renewLeaseStrict(writer, {projectId, ownerId, ttlMs: BUILD_LEASE_TTL_MS})) {
			throw new CodeIndexError('index_build_failed', 'Build lease was lost or taken over before publication');
		}

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
		// Refresh planner statistics inside the publication transaction so every
		// reader plans against the published row counts.
		analyzeDatabase(writer);
	});

	const publicationMs = Math.round(performance.now() - publicationStartedAt);
	writer.prepare('update generation set publication_ms = ? where id = ?').run(publicationMs, generationId);
	debug('generation published', {generationId, counts, publicationMs});
	return publicationMs;
};
