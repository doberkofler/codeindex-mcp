import {type DatabaseSync} from 'node:sqlite';
import {CodeIndexError} from '../errors/codeIndexError.ts';
import {type BuildStagesType} from '../model.ts';
import {debugFor} from '../logging/debug.ts';
import {writeContents} from './databaseContent.ts';
import {
	syncGenerationFiles,
	syncProjectContexts,
	validateGenerationFacts,
	writeGenerationFacts,
	type GenerationFactWriteModeType,
	type GenerationFactsInputType,
} from './databaseFacts.ts';
import {BUILD_LEASE_TTL_MS, renewLeaseStrict} from './databaseLease.ts';
import {readGeneration} from './databaseRead.ts';
import {asNumber, asString} from './databaseRows.ts';
import {analyzeDatabase} from './databaseStatistics.ts';
import {transaction} from './databaseTransaction.ts';
import {deleteAdapterRows, upsertAdapterRow} from './databaseAdapterRows.ts';
import {type AdapterCommitCountsType, type AdapterCommitType, type MultiGenerationCommitInputType} from './databaseCommitTypes.ts';

const debug = debugFor('database');
export type {AdapterCommitCountsType, AdapterCommitType, MultiGenerationCommitInputType} from './databaseCommitTypes.ts';
/** Refresh framing shared by a fact-writing commit and a fact-reuse commit. */
type GenerationCommitBaseType = Readonly<{
	/** `insert` creates the first published revision; `revise` updates it in place. */
	readonly mode: GenerationFactWriteModeType;
	readonly configHash: string;
	/** Declaration and module-resolution input hash; defaults to `configHash`. */
	readonly inputHash?: string;
	readonly stages: Readonly<{scanMs: number; compilerMs: number; extractionMs: number}>;
	/** Declared compiler version for this revision, when known. */
	readonly declaredCompilerVersion?: string | null;
	/** Runtime-versus-declared compiler drift for this revision. */
	readonly compilerDrift?: boolean;
	/** ISO start of this revision; keeps `started_at` describing one attempt. */
	readonly startedAt?: string;
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
	readonly counts: AdapterCommitCountsType;
	readonly changedPaths: readonly string[];
	readonly writtenRows: number;
	readonly reusedFacts: boolean;
	readonly stages: BuildStagesType;
}>;

type CommitConnectionType = Readonly<{writer: DatabaseSync; projectId: string}>;

const ZERO_COUNTS: AdapterCommitCountsType = {
	files: 0,
	symbols: 0,
	occurrences: 0,
	dependencyEdges: 0,
	dependencyBindings: 0,
	diagnostics: 0,
};

const zeroStages = (): Readonly<{scanMs: number; compilerMs: number; extractionMs: number}> => ({scanMs: 0, compilerMs: 0, extractionMs: 0});

const adapterRowCounts = (row: Readonly<Record<string, unknown>>): AdapterCommitCountsType => ({
	files: asNumber(row, 'file_count'),
	symbols: asNumber(row, 'symbol_count'),
	occurrences: asNumber(row, 'occurrence_count'),
	dependencyEdges: asNumber(row, 'dependency_edge_count'),
	dependencyBindings: asNumber(row, 'dependency_binding_count'),
	diagnostics: asNumber(row, 'diagnostic_count'),
});

const factCounts = (
	counts: Readonly<{files: number; symbols: number; occurrences: number; dependencyEdges: number; dependencyBindings: number; diagnostics: number}>,
): AdapterCommitCountsType => ({
	files: counts.files,
	symbols: counts.symbols,
	occurrences: counts.occurrences,
	dependencyEdges: counts.dependencyEdges,
	dependencyBindings: counts.dependencyBindings,
	diagnostics: counts.diagnostics,
});

const writeAdapter = (
	writer: DatabaseSync,
	generationId: string,
	adapter: AdapterCommitType,
	mode: GenerationFactWriteModeType,
): Readonly<{counts: AdapterCommitCountsType; validation: GenerationFactsInputType | null; changedPaths: readonly string[]; writtenRows: number}> => {
	if (adapter.coverage === 'absent') {
		deleteAdapterRows(writer, generationId, adapter.adapterId);
		return {counts: ZERO_COUNTS, validation: null, changedPaths: [], writtenRows: 0};
	}

	writeContents(writer, adapter.files);

	if (adapter.facts !== undefined) {
		const input: GenerationFactsInputType = {
			generationId,
			adapterId: adapter.adapterId,
			language: adapter.adapterId,
			files: adapter.files,
			projects: adapter.projects,
			facts: adapter.facts,
			dependencies: adapter.dependencies ?? {edges: [], bindings: []},
			diagnostics: adapter.diagnostics ?? [],
			sourceHash: adapter.sourceHash,
		};
		const write = writeGenerationFacts(writer, input, mode);

		return {counts: factCounts(write.counts), validation: input, changedPaths: write.changedPaths, writtenRows: write.writtenRows};
	}

	syncGenerationFiles(writer, generationId, adapter.files, adapter.adapterId);
	syncProjectContexts(writer, {generationId, adapterId: adapter.adapterId, projects: adapter.projects});

	return {counts: adapter.counts, validation: null, changedPaths: [], writtenRows: adapter.files.length};
};

const verifyAdapters = (writer: DatabaseSync, validations: readonly GenerationFactsInputType[]): void => {
	for (const validation of validations) {
		validateGenerationFacts(writer, validation);
	}

	const foreignKeyViolations = writer.prepare('pragma foreign_key_check').all();

	if (foreignKeyViolations.length > 0) {
		throw new Error('SQLite foreign-key check failed for the candidate generation');
	}

	const quickCheck = writer.prepare('pragma quick_check').all();

	if (quickCheck.some((row) => asString(row, 'quick_check') !== 'ok')) {
		throw new Error('SQLite quick check failed for the candidate generation');
	}
};

const sumCounts = (adapters: readonly Readonly<{counts: AdapterCommitCountsType}>[]): AdapterCommitCountsType =>
	adapters.reduce<AdapterCommitCountsType>(
		(total, adapter) => ({
			files: total.files + adapter.counts.files,
			symbols: total.symbols + adapter.counts.symbols,
			occurrences: total.occurrences + adapter.counts.occurrences,
			dependencyEdges: total.dependencyEdges + adapter.counts.dependencyEdges,
			dependencyBindings: total.dependencyBindings + adapter.counts.dependencyBindings,
			diagnostics: total.diagnostics + adapter.counts.diagnostics,
		}),
		ZERO_COUNTS,
	);

const sumStages = (adapters: readonly AdapterCommitType[]): Readonly<{scanMs: number; compilerMs: number; extractionMs: number}> =>
	adapters.reduce(
		(total, adapter) => ({
			scanMs: total.scanMs + adapter.stages.scanMs,
			compilerMs: total.compilerMs + adapter.stages.compilerMs,
			extractionMs: total.extractionMs + adapter.stages.extractionMs,
		}),
		zeroStages(),
	);

const publishPhase = (
	writer: DatabaseSync,
	input: Readonly<{
		generationId: string;
		adapters: readonly Readonly<{adapter: AdapterCommitType; counts: AdapterCommitCountsType}>[];
		sourceHash: string;
		configHash: string;
		inputHash: string;
		startedAt: string | undefined;
		stages: Readonly<{scanMs: number; compilerMs: number; extractionMs: number; insertionMs: number; verificationMs: number}>;
	}>,
): GenerationCommitType => {
	const previous = readGeneration(writer, input.generationId);

	if (previous === null) {
		throw new Error('Published generation disappeared before publication');
	}

	const counts = sumCounts(input.adapters);
	const present = input.adapters.filter((entry) => entry.adapter.coverage === 'present');
	const [primary] = (present.length > 0 ? present : [...input.adapters]).sort((left, right) => left.adapter.adapterId.localeCompare(right.adapter.adapterId));

	if (primary === undefined) {
		throw new Error('A generation requires at least one adapter');
	}

	writer
		.prepare(
			`update generation
			 set state = 'published', started_at = coalesce(?, started_at), completed_at = ?, revision = revision + 1,
			     extractor_id = ?, extractor_version = ?, compiler_version = ?, declared_compiler_version = ?, compiler_drift = ?,
			     config_hash = ?, source_hash = ?, input_hash = ?,
			     file_count = ?, symbol_count = ?, occurrence_count = ?,
			     dependency_edge_count = ?, dependency_binding_count = ?, diagnostic_count = ?,
			     scan_ms = ?, compiler_ms = ?, extraction_ms = ?, insertion_ms = ?, verification_ms = ?, publication_ms = ?
			 where id = ?`,
		)
		.run(
			input.startedAt ?? null,
			new Date().toISOString(),
			primary.adapter.adapterId,
			primary.adapter.adapterVersion,
			primary.adapter.compilerVersion,
			primary.adapter.declaredCompilerVersion,
			primary.adapter.compilerDrift ? 1 : 0,
			input.configHash,
			input.sourceHash,
			input.inputHash,
			counts.files,
			counts.symbols,
			counts.occurrences,
			counts.dependencyEdges,
			counts.dependencyBindings,
			counts.diagnostics,
			input.stages.scanMs,
			input.stages.compilerMs,
			input.stages.extractionMs,
			input.stages.insertionMs,
			input.stages.verificationMs,
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
		counts,
		changedPaths: [],
		writtenRows: 0,
		reusedFacts: false,
		stages: {
			scanMs: input.stages.scanMs,
			compilerMs: input.stages.compilerMs,
			extractionMs: input.stages.extractionMs,
			insertionMs: input.stages.insertionMs,
			verificationMs: input.stages.verificationMs,
			publicationMs: 0,
		},
	};
};

/**
 * Applies one multi-adapter refresh to the published generation in one transaction.
 *
 * Adapters are written sequentially inside the transaction. Each adapter owns its
 * facts and project contexts; adapters without facts keep the published rows.
 * Absent and removed adapters contribute no facts and their rows are deleted.
 *
 * @param connection - Writer connection and build-lease project identity.
 * @param input - Per-adapter contributions, combined hashes, and optional owner.
 * @returns Measured stages, persisted counts, and written row groups.
 * @throws {@link CodeIndexError} When the build lease was lost.
 * @throws {Error} When validation fails; the transaction is rolled back.
 */
export const commitAdapters = (connection: CommitConnectionType, input: MultiGenerationCommitInputType): GenerationCommitType => {
	const {writer, projectId} = connection;
	const outcome: {report: GenerationCommitType | null} = {report: null};
	let publicationMs = 0;
	const changedPaths: string[] = [];
	let writtenRows = 0;

	transaction(writer, () => {
		writer.exec('pragma defer_foreign_keys = on');

		if (input.ownerId !== undefined && !renewLeaseStrict(writer, {projectId, ownerId: input.ownerId, ttlMs: BUILD_LEASE_TTL_MS})) {
			throw new CodeIndexError('index_build_failed', 'Build lease was lost or taken over before publication');
		}

		for (const adapterId of input.removedAdapterIds ?? []) {
			deleteAdapterRows(writer, input.generationId, adapterId);
		}

		const mode: GenerationFactWriteModeType = input.mode ?? 'revise';
		const insertionStartedAt = performance.now();
		const written = input.adapters.map((adapter) => ({adapter, write: writeAdapter(writer, input.generationId, adapter, mode)}));
		const insertionMs = Math.round(performance.now() - insertionStartedAt);

		for (const entry of written) {
			upsertAdapterRow(writer, {
				generationId: input.generationId,
				adapter: entry.adapter,
				counts: entry.write.counts,
				stages: entry.adapter.stages,
			});
			changedPaths.push(...entry.write.changedPaths);
			writtenRows += entry.write.writtenRows;
		}

		const verificationStartedAt = performance.now();
		verifyAdapters(
			writer,
			written.map((entry) => entry.write.validation).filter((validation): validation is GenerationFactsInputType => validation !== null),
		);
		const verificationMs = Math.round(performance.now() - verificationStartedAt);
		const publicationStartedAt = performance.now();
		const report = publishPhase(writer, {
			generationId: input.generationId,
			adapters: written.map((entry) => ({adapter: entry.adapter, counts: entry.write.counts})),
			sourceHash: input.sourceHash,
			configHash: input.configHash,
			inputHash: input.inputHash,
			startedAt: input.startedAt,
			stages: {...sumStages(input.adapters), insertionMs, verificationMs},
		});

		publicationMs = Math.round(performance.now() - publicationStartedAt);
		outcome.report = {...report, changedPaths, writtenRows};
	});

	const {report} = outcome;

	if (report === null) {
		throw new Error('Generation commit did not complete');
	}

	writer.prepare('update generation set publication_ms = ? where id = ?').run(publicationMs, input.generationId);
	debug('generation committed', {generationId: input.generationId, revision: report.revision, changedPaths: report.changedPaths.length});
	return {...report, stages: {...report.stages, publicationMs}};
};

const adapterFromSingle = (writer: DatabaseSync, input: GenerationCommitInputType): AdapterCommitType => {
	const generation = readGeneration(writer, input.generationId);

	if (generation === null) {
		throw new Error('Generation disappeared before commit');
	}

	const factsInput = input.reuseFacts ? null : (input as GenerationFactsInputType & Readonly<{reuseFacts: false}>);
	const adapterId = factsInput?.adapterId ?? factsInput?.language ?? generation.extractorId;
	const previousRow = writer.prepare('select * from generation_adapter where generation_id = ? and adapter_id = ?').get(input.generationId, adapterId);
	const counts =
		previousRow === undefined
			? {
					files: generation.fileCount,
					symbols: generation.symbolCount,
					occurrences: generation.occurrenceCount,
					dependencyEdges: generation.dependencyEdgeCount,
					dependencyBindings: generation.dependencyBindingCount,
					diagnostics: generation.diagnosticCount,
				}
			: adapterRowCounts(previousRow);

	return {
		adapterId,
		adapterVersion: generation.extractorVersion,
		compilerVersion: generation.compilerVersion,
		declaredCompilerVersion: input.declaredCompilerVersion ?? generation.declaredCompilerVersion,
		compilerDrift: input.compilerDrift ?? generation.compilerDrift,
		coverage: 'present',
		absenceReason: null,
		sourceHash: input.sourceHash,
		configHash: input.configHash,
		inputHash: input.inputHash ?? input.configHash,
		counts,
		stages: input.stages,
		files: input.files,
		projects: input.projects,
		...(factsInput === null
			? {}
			: {
					facts: factsInput.facts,
					dependencies: factsInput.dependencies,
					diagnostics: factsInput.diagnostics,
				}),
	};
};

/**
 * Applies one refresh to the published generation in a single transaction.
 *
 * Kept for storage tests and singular callers; production refreshes use
 * {@link commitAdapters}. The singular path is a one-adapter multi commit.
 *
 * @param connection - Writer connection and build-lease project identity.
 * @param input - Scan manifest, facts, stages, and optional lease owner.
 * @returns Measured stages, persisted counts, and written row groups.
 * @throws {@link CodeIndexError} When the build lease was lost.
 * @throws {Error} When validation fails; the transaction is rolled back.
 */
export const commitGeneration = (connection: CommitConnectionType, input: GenerationCommitInputType): GenerationCommitType => {
	const adapter = adapterFromSingle(connection.writer, input);

	return commitAdapters(connection, {
		generationId: input.generationId,
		adapters: [adapter],
		mode: input.mode,
		sourceHash: input.sourceHash,
		configHash: input.configHash,
		inputHash: input.inputHash ?? input.configHash,
		...(input.startedAt === undefined ? {} : {startedAt: input.startedAt}),
		...(input.ownerId === undefined ? {} : {ownerId: input.ownerId}),
	});
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
