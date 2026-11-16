import {type DatabaseSync} from 'node:sqlite';
import {CodeIndexError} from '../errors/codeIndexError.ts';
import {type BuildPersistenceType, type BuildStagesType} from '../model.ts';
import {debugFor} from '../logging/debug.ts';
import {writeContents} from './databaseContent.ts';
import {
	syncGenerationFiles,
	syncProjectContexts,
	writeGenerationFacts,
	type GenerationFactWriteModeType,
	type GenerationFactsInputType,
} from './databaseFacts.ts';
import {validateGenerationFactCounts, validateGenerationSemantics} from './databaseFactValidation.ts';
import {BUILD_LEASE_TTL_MS, renewLeaseStrict} from './databaseLease.ts';
import {readGeneration} from './databaseRead.ts';
import {asNumber} from './databaseRows.ts';
import {analyzeDatabase} from './databaseStatistics.ts';
import {timedTransaction} from './databaseTransaction.ts';
import {deleteAdapterRows, upsertAdapterRow} from './databaseAdapterRows.ts';
import {persistedAdapterCounts, persistedAdapterStages} from './databaseCommitAggregates.ts';
import {
	type AdapterCommitCountsType,
	type AdapterCommitType,
	type GenerationCommitInputType,
	type MultiGenerationCommitInputType,
} from './databaseCommitTypes.ts';
import {buildPersistence, checkpointAfterPublication} from './databaseCommitTelemetry.ts';

const debug = debugFor('database');
export type {AdapterCommitCountsType, AdapterCommitType, GenerationCommitInputType, MultiGenerationCommitInputType} from './databaseCommitTypes.ts';

/**
 * Renews the publication lease or rejects publication after ownership loss.
 *
 * @param connection - Writer connection and build-lease project identity.
 * @param ownerId - Optional lease owner; omitted for unleased storage tests.
 * @throws {@link CodeIndexError} When another process took over the lease.
 */
export const assertPublicationLease = (connection: CommitConnectionType, ownerId: string | undefined): void => {
	if (
		ownerId !== undefined &&
		!renewLeaseStrict(connection.writer, {
			projectId: connection.projectId,
			ownerId,
			ttlMs: BUILD_LEASE_TTL_MS,
		})
	) {
		throw new CodeIndexError('index_build_failed', 'Build lease was lost or taken over before publication');
	}
};

/** Persisted outcome of one refresh. */
export type GenerationCommitType = Readonly<{
	readonly generationId: string;
	readonly revision: number;
	readonly counts: AdapterCommitCountsType;
	readonly changedPaths: readonly string[];
	readonly writtenRows: number;
	readonly reusedFacts: boolean;
	readonly stages: BuildStagesType;
	readonly persistence: BuildPersistenceType;
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
): Readonly<{
	counts: AdapterCommitCountsType;
	validation: GenerationFactsInputType | null;
	changedPaths: readonly string[];
	selectedRows: number;
	deletedRows: number;
	writtenRows: number;
}> => {
	if (adapter.coverage === 'absent') {
		deleteAdapterRows(writer, generationId, adapter.adapterId);
		return {counts: ZERO_COUNTS, validation: null, changedPaths: [], selectedRows: 0, deletedRows: 0, writtenRows: 0};
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

		return {
			counts: factCounts(write.counts),
			validation: input,
			changedPaths: write.changedPaths,
			selectedRows: write.selectedRows,
			deletedRows: write.deletedRows,
			writtenRows: write.writtenRows,
		};
	}

	syncGenerationFiles(writer, generationId, adapter.files, adapter.adapterId);
	syncProjectContexts(writer, {generationId, adapterId: adapter.adapterId, projects: adapter.projects});

	return {
		counts: adapter.counts,
		validation: null,
		changedPaths: [],
		selectedRows: adapter.files.length + adapter.projects.length,
		deletedRows: 0,
		writtenRows: adapter.files.length + adapter.projects.length,
	};
};

const validateAdapterCounts = (writer: DatabaseSync, validations: readonly GenerationFactsInputType[]): void => {
	for (const validation of validations) {
		validateGenerationFactCounts(writer, validation);
	}
};

const validateAdapterSemantics = (writer: DatabaseSync, validations: readonly GenerationFactsInputType[]): void => {
	for (const validation of validations) {
		validateGenerationSemantics(writer, validation);
	}
};

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
		sourceHash: string;
		configHash: string;
		inputHash: string;
		startedAt: string | undefined;
		/** Stages measured by this attempt; returned to the caller. */
		stages: Readonly<{scanMs: number; compilerMs: number; extractionMs: number; insertionMs: number; verificationMs: number}>;
		/** Whole-generation stage totals persisted on the generation row. */
		aggregateStages: Readonly<{scanMs: number; compilerMs: number; extractionMs: number}>;
	}>,
): Readonly<{
	report: Omit<GenerationCommitType, 'persistence'>;
	publicationMetadataMs: number;
	contentGcMs: number;
	plannerStatisticsMs: number;
}> => {
	const metadataStartedAt = performance.now();
	const previous = readGeneration(writer, input.generationId);

	if (previous === null) {
		throw new Error('Published generation disappeared before publication');
	}

	const counts = persistedAdapterCounts(writer, input.generationId);

	if (counts === null) {
		throw new Error('A generation requires at least one adapter');
	}

	writer
		.prepare(
			`update generation
			 set state = 'published', started_at = coalesce(?, started_at), completed_at = ?, revision = revision + 1,
			     config_hash = ?, source_hash = ?, input_hash = ?,
			     file_count = ?, symbol_count = ?, occurrence_count = ?,
			     dependency_edge_count = ?, dependency_binding_count = ?, diagnostic_count = ?,
			     scan_ms = ?, compiler_ms = ?, extraction_ms = ?, insertion_ms = ?, verification_ms = ?, publication_ms = ?
			 where id = ?`,
		)
		.run(
			input.startedAt ?? null,
			new Date().toISOString(),
			input.configHash,
			input.sourceHash,
			input.inputHash,
			counts.files,
			counts.symbols,
			counts.occurrences,
			counts.dependencyEdges,
			counts.dependencyBindings,
			counts.diagnostics,
			input.aggregateStages.scanMs,
			input.aggregateStages.compilerMs,
			input.aggregateStages.extractionMs,
			input.stages.insertionMs,
			input.stages.verificationMs,
			null,
			input.generationId,
		);

	writer
		.prepare("insert into metadata (key, value) values ('current_generation', ?) on conflict(key) do update set value = excluded.value")
		.run(input.generationId);
	const publicationMetadataMs = Math.round(performance.now() - metadataStartedAt);
	const contentGcStartedAt = performance.now();
	writer.exec('delete from content where not exists (select 1 from file where file.content_sha256 = content.sha256)');
	const contentGcMs = Math.round(performance.now() - contentGcStartedAt);
	const plannerStatisticsStartedAt = performance.now();
	analyzeDatabase(writer);
	const plannerStatisticsMs = Math.round(performance.now() - plannerStatisticsStartedAt);

	return {
		report: {
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
		},
		publicationMetadataMs,
		contentGcMs,
		plannerStatisticsMs,
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
	const {writer} = connection;
	const persistenceStartedAt = performance.now();
	const outcome: {report: Omit<GenerationCommitType, 'persistence'> | null} = {report: null};
	let insertionMs = 0;
	let countValidationMs = 0;
	let semanticValidationMs = 0;
	let publicationMetadataMs = 0;
	let contentGcMs = 0;
	let plannerStatisticsMs = 0;
	let publicationStartedAt = 0;
	const changedPaths: string[] = [];
	let selectedRows = 0;
	let deletedRows = 0;
	let writtenRows = 0;

	const transactionTiming = timedTransaction(writer, () => {
		writer.exec('pragma defer_foreign_keys = on');
		assertPublicationLease(connection, input.ownerId);

		const insertionStartedAt = performance.now();

		for (const adapterId of input.removedAdapterIds ?? []) {
			deleteAdapterRows(writer, input.generationId, adapterId);
		}

		const mode: GenerationFactWriteModeType = input.mode ?? 'revise';
		const written = input.adapters.map((adapter) => ({adapter, write: writeAdapter(writer, input.generationId, adapter, mode)}));

		for (const entry of written) {
			upsertAdapterRow(writer, {
				generationId: input.generationId,
				adapter: entry.adapter,
				counts: entry.write.counts,
				stages: entry.adapter.stages,
			});
			changedPaths.push(...entry.write.changedPaths);
			selectedRows += entry.write.selectedRows;
			deletedRows += entry.write.deletedRows;
			writtenRows += entry.write.writtenRows;
		}
		insertionMs = Math.round(performance.now() - insertionStartedAt);

		const validations = written.map((entry) => entry.write.validation).filter((validation): validation is GenerationFactsInputType => validation !== null);
		const countValidationStartedAt = performance.now();
		validateAdapterCounts(writer, validations);
		countValidationMs = Math.round(performance.now() - countValidationStartedAt);
		const semanticValidationStartedAt = performance.now();
		validateAdapterSemantics(writer, validations);
		semanticValidationMs = Math.round(performance.now() - semanticValidationStartedAt);
		publicationStartedAt = performance.now();
		const {
			report: publishedReport,
			contentGcMs: measuredContentGcMs,
			publicationMetadataMs: measuredPublicationMetadataMs,
			plannerStatisticsMs: measuredPlannerStatisticsMs,
		} = publishPhase(writer, {
			generationId: input.generationId,
			sourceHash: input.sourceHash,
			configHash: input.configHash,
			inputHash: input.inputHash,
			startedAt: input.startedAt,
			stages: {...sumStages(input.adapters), insertionMs, verificationMs: countValidationMs + semanticValidationMs},
			aggregateStages: persistedAdapterStages(writer, input.generationId),
		});

		contentGcMs = measuredContentGcMs;
		publicationMetadataMs = measuredPublicationMetadataMs;
		plannerStatisticsMs = measuredPlannerStatisticsMs;
		outcome.report = {...publishedReport, changedPaths, writtenRows};
	});

	const {report} = outcome;

	if (report === null) {
		throw new Error('Generation commit did not complete');
	}

	const publicationCoreMs = Math.round(performance.now() - publicationStartedAt);
	const completionMetadataStartedAt = performance.now();
	writer.prepare('update generation set publication_ms = ? where id = ?').run(publicationCoreMs, input.generationId);
	publicationMetadataMs += Math.round(performance.now() - completionMetadataStartedAt);
	const publicationCheckpoint = checkpointAfterPublication(writer);
	const publicationMs = Math.round(performance.now() - publicationStartedAt);
	const persistence = buildPersistence({
		queueWaitMs: transactionTiming.queueWaitMs,
		changedPathCount: changedPaths.length,
		selectedRowCount: selectedRows,
		deletedRowCount: deletedRows,
		writtenRowCount: writtenRows,
		insertionMs,
		countValidationMs,
		semanticValidationMs,
		publicationMetadataMs,
		contentGcMs,
		plannerStatisticsMs,
		commitMs: transactionTiming.commitMs,
		publicationCheckpoint,
		totalWallMs: Math.round(performance.now() - persistenceStartedAt),
	});
	debug('generation committed', {generationId: input.generationId, revision: report.revision, changedPaths: report.changedPaths.length});
	return {...report, stages: {...report.stages, publicationMs}, persistence};
};

const adapterFromSingle = (writer: DatabaseSync, input: GenerationCommitInputType): AdapterCommitType => {
	const generation = readGeneration(writer, input.generationId);

	if (generation === null) {
		throw new Error('Generation disappeared before commit');
	}

	const factsInput = input.reuseFacts ? null : (input as GenerationFactsInputType & Readonly<{reuseFacts: false}>);
	const {provenance} = input;
	const {adapterId} = provenance;
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
		protocolVersion: provenance.protocolVersion,
		adapterVersion: provenance.adapterVersion,
		packageName: provenance.packageName,
		packageVersion: provenance.packageVersion,
		compilerVersion: provenance.compilerVersion,
		declaredCompilerVersion: input.declaredCompilerVersion ?? provenance.declaredCompilerVersion,
		compilerDrift: input.compilerDrift ?? provenance.compilerDrift,
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
