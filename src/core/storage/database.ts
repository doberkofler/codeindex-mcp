import {type DatabaseSync} from 'node:sqlite';
import {
	type BuildLeaseType,
	type BuildStatType,
	type GenerationRowType,
	type IndexedDependencyBindingType,
	type SourceFileType,
	type StoredDependencyEdgeType,
	type SymbolSummaryType,
	type WorkingCopyIdentityType,
} from '../model.ts';
import {debugFor} from '../logging/debug.ts';
import {CodeIndexError} from '../errors/codeIndexError.ts';
import {
	countContentVersions,
	countExtractionArtifacts as countStoredExtractionArtifacts,
	countReferences as countStoredReferences,
	databaseSizeBytes as readDatabaseSizeBytes,
	getExtractionArtifact,
	hasExtractionArtifact,
	insertContents,
	listContentHashes as listStoredContentHashes,
	listFiles as listStoredFiles,
	putExtractionArtifact,
	readFile,
	type ExtractionArtifactKeyType,
} from './databaseContent.ts';
import {
	findDependencyEdgesByTargetIdentifier,
	findDependencyEdgesByTargets,
	listDependencyBindings as listStoredDependencyBindings,
} from './databaseDependency.ts';
import {countGenerationRows, insertGenerationFacts, type GenerationFactCountsType, type GenerationFactsInputType} from './databaseFacts.ts';
import {ensureIdentity, ensureMetadata, readWorkingCopy, type DatabaseOpenContextType} from './databaseIdentity.ts';
import {acquireLease, BUILD_LEASE_TTL_MS, readLease, releaseLease, renewLease, renewLeaseStrict} from './databaseLease.ts';
import {explainQueryPlan, openDatabaseConnections} from './databaseOpen.ts';
import {registerProcessOwner, type ProcessOwnerType} from './processOwnership.ts';
import {findReusableGeneration as findStoredReusableGeneration, readGeneration, readPublishedGeneration} from './databaseRead.ts';
import {asString} from './databaseRows.ts';
import {listProjectContextNames as listStoredProjectContextNames} from './databaseContextQueries.ts';
import {
	bindingBelongsToSymbol,
	bindingContextsFor,
	bindingDetailsForSymbols,
	bindingExposure,
	bindingSitesFor,
	definitionSiteById,
	definitionSitesForSymbol,
	definitionSitesForSymbols,
	findBindingCandidates,
	outlineReexports as readOutlineReexports,
	outlineSymbols as readOutlineSymbols,
	referenceCoverage,
	referenceRows,
	symbolAncestors,
	symbolSummaryById,
	symbolsAtPosition,
} from './databasePublicationQueries.ts';
import {transaction} from './databaseTransaction.ts';

const debug = debugFor('database');

export type {DatabaseOpenContextType} from './databaseIdentity.ts';
export {BUILD_LEASE_TTL_MS} from './databaseLease.ts';

/**
 * Opens and owns the SQLite index.
 *
 * The database is derived data. An incompatible schema is moved aside as one
 * `.schema-<version>.bak` file and rebuilt; there is no in-place migration.
 * One writer and one reader connection are kept open. Every query filters on an
 * explicitly published generation, so a build in progress is never visible.
 */
export class IndexDatabase {
	readonly #reader: DatabaseSync;
	readonly #writer: DatabaseSync;
	readonly #projectId: string;
	readonly #owner: ProcessOwnerType | null;

	private constructor(reader: DatabaseSync, writer: DatabaseSync, projectId: string, owner: ProcessOwnerType | null) {
		this.#reader = reader;
		this.#writer = writer;
		this.#projectId = projectId;
		this.#owner = owner;
	}

	/**
	 * Opens an index database, recreating an incompatible cache.
	 *
	 * @param databasePath - SQLite file path, or `:memory:` for a single connection.
	 * @param context - Working-copy and project identity used by this database.
	 * @returns The opened database.
	 */
	public static open(databasePath: string, context: DatabaseOpenContextType = {}): IndexDatabase {
		const owner = databasePath === ':memory:' ? null : registerProcessOwner(databasePath);

		try {
			const {writer, reader} = openDatabaseConnections(databasePath);
			const projectId = context.projectId ?? 'default';
			const database = new IndexDatabase(reader, writer, projectId, owner);
			ensureMetadata(writer);
			ensureIdentity({writer, reader, context});
			database.discardIncompleteGenerations();
			debug('database opened', {path: databasePath, projectId});

			return database;
		} catch (error) {
			owner?.release();
			throw error;
		}
	}

	public getWorkingCopy(): WorkingCopyIdentityType | null {
		return readWorkingCopy(this.#reader);
	}

	public discardIncompleteGenerations(): void {
		this.#writer.exec(
			`delete from generation
			 where state = 'failed'
			 or (state = 'building' and julianday(started_at) < julianday('now', '-1 hour'))`,
		);
		debug('incomplete generations discarded');
	}

	public getGeneration(id: string): GenerationRowType | null {
		return readGeneration(this.#reader, id);
	}

	public getPublishedGeneration(): GenerationRowType | null {
		return readPublishedGeneration(this.#reader);
	}

	public findReusableGeneration(sourceHash: string, configHash: string): GenerationRowType | null {
		return findStoredReusableGeneration(this.#reader, sourceHash, configHash);
	}

	public createGeneration(
		input: Readonly<{id: string; extractorId: string; extractorVersion: string; compilerVersion: string; sourceHash: string; configHash: string}>,
	): void {
		this.#writer
			.prepare(
				`insert into generation (id, state, extractor_id, extractor_version, compiler_version, source_hash, config_hash, started_at)
				 values (?, 'building', ?, ?, ?, ?, ?, ?)`,
			)
			.run(input.id, input.extractorId, input.extractorVersion, input.compilerVersion, input.sourceHash, input.configHash, new Date().toISOString());
	}

	/**
	 * Inserts immutable content versions keyed by raw SHA-256.
	 *
	 * @param files - Authored files to read and store.
	 * @returns The number of content rows inserted.
	 */
	public insertContents(files: readonly SourceFileType[]): number {
		const inserted = insertContents(this.#writer, files);
		debug('contents inserted', {files: files.length, inserted});
		return inserted;
	}

	/**
	 * Persists one complete finalized fact set for a building generation.
	 *
	 * This is the single generation-fact storage operation. It owns FK-safe
	 * insertion order, count checks, and pre-publication validation.
	 *
	 * @param input - Files, finalized facts, dependencies, diagnostics, and hashes.
	 * @returns Persisted row counts.
	 * @throws {@link Error} When the generation is not building or validation fails.
	 */
	public insertGenerationFacts(input: GenerationFactsInputType): GenerationFactCountsType {
		debug('insert generation facts', {generationId: input.generationId, symbols: input.facts.symbols.length});
		const counts = insertGenerationFacts(this.#writer, this.#reader, input);
		debug('generation facts inserted', {generationId: input.generationId, counts});
		return counts;
	}

	public putExtractionArtifact(input: ExtractionArtifactKeyType & Readonly<{artifactJson: string}>): void {
		putExtractionArtifact(this.#writer, input);
	}

	public getExtractionArtifact(input: ExtractionArtifactKeyType): string | null {
		return getExtractionArtifact(this.#reader, input);
	}

	public hasExtractionArtifact(input: ExtractionArtifactKeyType): boolean {
		return hasExtractionArtifact(this.#reader, input);
	}

	public countRows(
		generationId: string,
		table:
			| 'file'
			| 'symbol'
			| 'symbol_name'
			| 'symbol_name_context'
			| 'symbol_name_site'
			| 'surface_binding_origin'
			| 'occurrence'
			| 'definition_site'
			| 'dependency_edge'
			| 'dependency_binding'
			| 'diagnostic'
			| 'build_stats',
	): number {
		return countGenerationRows(this.#reader, generationId, table);
	}

	public getBuildLease(): BuildLeaseType | null {
		return readLease(this.#reader, this.#projectId);
	}

	public tryAcquireBuildLease(ownerId: string, processId: number, ttlMs: number): boolean {
		return acquireLease(this.#writer, {projectId: this.#projectId, ownerId, processId, ttlMs});
	}

	public renewBuildLease(ownerId: string, ttlMs: number): boolean {
		return renewLease(this.#writer, {projectId: this.#projectId, ownerId, ttlMs});
	}

	public releaseBuildLease(ownerId: string): void {
		releaseLease(this.#writer, this.#projectId, ownerId);
	}

	/**
	 * Publishes one complete generation and supersedes the previous publication.
	 *
	 * Previous rows are retained as `superseded` for one generation so in-flight
	 * queries with a cached generation identifier can still complete. Unreferenced
	 * content and artifacts are removed.
	 *
	 * @param generationId - Completed generation identifier.
	 * @param diagnosticCount - Persisted diagnostic count; defaults to a count query.
	 * @param stages - Optional measured build-stage durations.
	 * @param ownerId - Lease owner that must still own the build lease.
	 * @returns Measured publication duration.
	 * @throws {@link CodeIndexError} When the lease was lost or expired before publication.
	 */
	public publish(
		generationId: string,
		diagnosticCount?: number,
		stages?: Readonly<{scanMs: number; compilerMs: number; extractionMs: number; insertionMs: number; verificationMs: number}>,
		ownerId?: string,
	): number {
		const counts = {
			files: this.countRows(generationId, 'file'),
			symbols: this.countRows(generationId, 'symbol'),
			occurrences: this.countRows(generationId, 'occurrence'),
			dependencyEdges: this.countRows(generationId, 'dependency_edge'),
			dependencyBindings: this.countRows(generationId, 'dependency_binding'),
			diagnostics: diagnosticCount ?? this.countRows(generationId, 'diagnostic'),
		};
		debug('publish generation', {generationId, counts});
		const publicationStartedAt = performance.now();

		this.#transaction(() => {
			if (ownerId !== undefined && !renewLeaseStrict(this.#writer, {projectId: this.#projectId, ownerId, ttlMs: BUILD_LEASE_TTL_MS})) {
				throw new CodeIndexError('index_build_failed', 'Build lease was lost or taken over before publication');
			}

			this.#writer.exec("delete from generation where state in ('superseded', 'failed')");

			this.#writer
				.prepare(
					`update generation
					 set state = 'published', completed_at = ?, file_count = ?, symbol_count = ?, occurrence_count = ?,
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

			this.#writer.prepare("update generation set state = 'superseded' where state = 'published' and id <> ?").run(generationId);
			this.#writer
				.prepare("insert into metadata (key, value) values ('current_generation', ?) on conflict(key) do update set value = excluded.value")
				.run(generationId);
			this.#writer.exec('delete from content where not exists (select 1 from file where file.content_sha256 = content.sha256)');
		});
		const publicationMs = Math.round(performance.now() - publicationStartedAt);
		this.#writer.prepare('update generation set publication_ms = ? where id = ?').run(publicationMs, generationId);
		debug('generation published', {generationId, counts, publicationMs});
		return publicationMs;
	}

	public markFailed(generationId: string, message: string): void {
		this.#writer
			.prepare("update generation set state = 'failed', completed_at = ?, error = ? where id = ?")
			.run(new Date().toISOString(), message, generationId);
	}

	public verifyIntegrity(): void {
		const integrity = this.#reader.prepare('pragma integrity_check').all();
		const integrityFailures = integrity.filter((row) => asString(row, 'integrity_check') !== 'ok');

		if (integrityFailures.length > 0) {
			throw new Error('SQLite integrity check failed');
		}

		const foreignKeyFailures = this.#reader.prepare('pragma foreign_key_check').all();

		if (foreignKeyFailures.length > 0) {
			throw new Error('SQLite foreign-key check failed');
		}
	}

	public listBuildStats(generationId: string): readonly BuildStatType[] {
		return this.#reader
			.prepare('select language, metric, dim1, dim2, dim3, value from build_stats where generation_id = ? order by language, metric, dim1, dim2, dim3')
			.all(generationId)
			.map((row) => ({
				language: asString(row, 'language'),
				metric: asString(row, 'metric'),
				dim1: asString(row, 'dim1'),
				dim2: asString(row, 'dim2'),
				dim3: asString(row, 'dim3'),
				value: Number(row['value']),
			}));
	}

	public getFile(generationId: string, filePath: string): SourceFileType | null {
		return readFile(this.#reader, generationId, filePath);
	}

	public listFiles(generationId: string): readonly Readonly<{path: string; sha256: string}>[] {
		return listStoredFiles(this.#reader, generationId);
	}
	public listProjectContextNames(generationId: string): readonly string[] {
		return listStoredProjectContextNames(this.#reader, generationId);
	}

	public getSymbol(generationId: string, id: string): SymbolSummaryType | null {
		return symbolSummaryById(this.#reader, generationId, id);
	}

	public symbolAncestors(generationId: string, id: string): readonly SymbolSummaryType[] {
		return symbolAncestors(this.#reader, generationId, id);
	}

	public symbolsAtPosition(input: Readonly<{generationId: string; path: string; line: number; column: number | null}>): ReturnType<typeof symbolsAtPosition> {
		return symbolsAtPosition(this.#reader, input);
	}

	public findBindingCandidates(input: Parameters<typeof findBindingCandidates>[1]): ReturnType<typeof findBindingCandidates> {
		return findBindingCandidates(this.#reader, input);
	}

	public bindingDetails(input: Parameters<typeof bindingDetailsForSymbols>[1]): ReturnType<typeof bindingDetailsForSymbols> {
		return bindingDetailsForSymbols(this.#reader, input);
	}

	public bindingContexts(generationId: string, bindingIds: readonly string[]): ReturnType<typeof bindingContextsFor> {
		return bindingContextsFor(this.#reader, generationId, bindingIds);
	}

	public bindingSites(generationId: string, bindingIds: readonly string[]): ReturnType<typeof bindingSitesFor> {
		return bindingSitesFor(this.#reader, generationId, bindingIds);
	}

	public definitionSites(input: Parameters<typeof definitionSitesForSymbols>[1]): ReturnType<typeof definitionSitesForSymbols> {
		return definitionSitesForSymbols(this.#reader, input);
	}

	public definitionSitesForSymbol(generationId: string, symbolId: string): ReturnType<typeof definitionSitesForSymbol> {
		return definitionSitesForSymbol(this.#reader, generationId, symbolId);
	}

	public definitionSite(generationId: string, symbolId: string, siteId: string): ReturnType<typeof definitionSiteById> {
		return definitionSiteById(this.#reader, generationId, symbolId, siteId);
	}

	public bindingBelongsToSymbol(generationId: string, symbolId: string, bindingId: string): boolean {
		return bindingBelongsToSymbol(this.#reader, generationId, symbolId, bindingId);
	}

	public bindingExposure(generationId: string, bindingId: string, context?: string): ReturnType<typeof bindingExposure> {
		return bindingExposure(this.#reader, generationId, bindingId, context);
	}

	public outlineSymbols(input: Parameters<typeof readOutlineSymbols>[1]): ReturnType<typeof readOutlineSymbols> {
		debug('list outline', {generationId: input.generationId, path: input.path, kinds: input.kinds, limit: input.limit, offset: input.offset});
		return readOutlineSymbols(this.#reader, input);
	}

	public outlineReexports(generationId: string, pathName: string): ReturnType<typeof readOutlineReexports> {
		return readOutlineReexports(this.#reader, generationId, pathName);
	}

	public findReferenceRows(input: Parameters<typeof referenceRows>[1]): ReturnType<typeof referenceRows> {
		return referenceRows(this.#reader, input);
	}

	public referenceCoverage(input: Parameters<typeof referenceCoverage>[1]): ReturnType<typeof referenceCoverage> {
		return referenceCoverage(this.#reader, input);
	}

	public findDependencyEdgesByTargetIdentifier(generationId: string, targetIdentifier: string, context?: string): readonly StoredDependencyEdgeType[] {
		return findDependencyEdgesByTargetIdentifier(this.#reader, generationId, targetIdentifier, context);
	}

	public findDependencyEdgesByTargets(generationId: string, targetPaths: readonly string[], context?: string): readonly StoredDependencyEdgeType[] {
		return findDependencyEdgesByTargets(this.#reader, generationId, targetPaths, context);
	}

	public listDependencyBindings(generationId: string, edgeIds: readonly string[]): readonly IndexedDependencyBindingType[] {
		return listStoredDependencyBindings(this.#reader, generationId, edgeIds);
	}

	public countReferences(generationId: string, symbolId: string): number {
		return countStoredReferences(this.#reader, generationId, symbolId);
	}

	public explainQueryPlan(sql: string, parameters: readonly (string | number)[] = []): readonly string[] {
		return explainQueryPlan(this.#reader, sql, parameters);
	}

	public databaseSizeBytes(): number {
		return readDatabaseSizeBytes(this.#reader);
	}

	public contentVersionCount(): number {
		return countContentVersions(this.#reader);
	}

	public contentHashes(): readonly string[] {
		return listStoredContentHashes(this.#reader);
	}

	public extractionArtifactCount(): number {
		return countStoredExtractionArtifacts(this.#reader);
	}

	public close(): void {
		debug('close database');

		try {
			if (this.#reader !== this.#writer) {
				this.#reader.close();
			}

			this.#writer.close();
		} finally {
			this.#owner?.release();
		}
	}

	#transaction(action: () => void): void {
		transaction(this.#writer, action);
	}
}
