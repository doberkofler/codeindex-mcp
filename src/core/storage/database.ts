import {type DatabaseSync} from 'node:sqlite';
import {
	type BuildLeaseType,
	type DiagnosticType,
	type GenerationRowType,
	type IndexedDependencyBindingType,
	type IndexedDependencyEdgeType,
	type IndexedOccurrenceType,
	type IndexedSymbolType,
	type ReferenceType,
	type ScanProjectResultType,
	type SourceFileType,
	type StoredDependencyEdgeType,
	type SymbolMatchType,
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
	insertContents,
	listContentHashes as listStoredContentHashes,
	listFiles as listStoredFiles,
	putExtractionArtifact,
	readFile,
	type ExtractionArtifactKeyType,
} from './databaseContent.ts';
import {
	findDependencyEdgesByPackage,
	findDependencyEdgesByTargets,
	insertDependencyBindings as insertStoredDependencyBindings,
	insertDependencyEdges as insertStoredDependencyEdges,
	listDependencyBindings as listStoredDependencyBindings,
} from './databaseDependency.ts';
import {ensureIdentity, ensureMetadata, readWorkingCopy, type DatabaseOpenContextType} from './databaseIdentity.ts';
import {acquireLease, ownsLease, readLease, releaseLease, renewLease} from './databaseLease.ts';
import {explainQueryPlan, openDatabaseConnections} from './databaseOpen.ts';
import {registerProcessOwner, type ProcessOwnerType} from './processOwnership.ts';
import {findReusableGeneration as findStoredReusableGeneration, readGeneration, readPublishedGeneration} from './databaseRead.ts';
import {asNumber, asString, SYMBOL_COLUMNS, toSymbolSummary} from './databaseRows.ts';
import {
	insertOccurrenceContexts,
	insertProjectContexts,
	insertSymbolContexts,
	listProjectContextNames as listStoredProjectContextNames,
	listSymbolContexts,
} from './databaseContextQueries.ts';
import {findReferences as findStoredReferences, findSymbols as findStoredSymbols, outlineQuerySql} from './databaseSymbolQueries.ts';
import {transaction} from './databaseTransaction.ts';

const debug = debugFor('database');

export type {DatabaseOpenContextType} from './databaseIdentity.ts';

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
			ensureIdentity({writer, reader, context, databasePath});
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

	public insertFiles(generationId: string, files: readonly SourceFileType[], projects: readonly ScanProjectResultType[] = []): void {
		debug('insert files', {generationId, files: files.length, projects: projects.length});
		const statement = this.#writer.prepare(
			`insert into file (generation_id, path, sha256, content_sha256, line_count)
			 values (?, ?, ?, (select sha256 from content where sha256 = ?), ?)`,
		);

		this.#transaction(() => {
			insertProjectContexts(this.#writer, generationId, projects);

			for (const file of files) {
				statement.run(generationId, file.path, file.sha256, file.sha256, file.lineCount);
			}
		});
	}

	public insertSymbols(generationId: string, symbols: readonly IndexedSymbolType[]): void {
		debug('insert symbols', {generationId, symbols: symbols.length});
		const statement = this.#writer.prepare(
			`insert into symbol (generation_id, id, name, qualified_name, kind, path, start_line, start_column, end_line, end_column, start_offset, end_offset, enclosing_id)
			 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		this.#transaction(() => {
			for (const symbol of symbols) {
				statement.run(
					generationId,
					symbol.id,
					symbol.name,
					symbol.qualifiedName,
					symbol.kind,
					symbol.path,
					symbol.startLine,
					symbol.startColumn,
					symbol.endLine,
					symbol.endColumn,
					symbol.startOffset,
					symbol.endOffset,
					symbol.enclosingId,
				);
			}

			insertSymbolContexts(this.#writer, generationId, symbols);
		});
	}

	public insertOccurrences(generationId: string, occurrences: readonly IndexedOccurrenceType[]): void {
		debug('insert occurrences', {generationId, occurrences: occurrences.length});
		const statement = this.#writer.prepare(
			`insert into occurrence (generation_id, symbol_id, path, start_line, start_column, end_line, end_column, start_offset, end_offset, role, enclosing_id)
			 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		this.#transaction(() => {
			for (const occurrence of occurrences) {
				statement.run(
					generationId,
					occurrence.symbolId,
					occurrence.path,
					occurrence.startLine,
					occurrence.startColumn,
					occurrence.endLine,
					occurrence.endColumn,
					occurrence.startOffset,
					occurrence.endOffset,
					occurrence.role,
					occurrence.enclosingId,
				);
			}

			insertOccurrenceContexts(this.#writer, generationId, occurrences);
		});
	}

	public insertDependencyEdges(generationId: string, edges: readonly IndexedDependencyEdgeType[]): void {
		debug('insert dependency edges', {generationId, edges: edges.length});
		insertStoredDependencyEdges(this.#writer, generationId, edges);
	}

	public insertDependencyBindings(generationId: string, bindings: readonly IndexedDependencyBindingType[]): void {
		debug('insert dependency bindings', {generationId, bindings: bindings.length});
		insertStoredDependencyBindings(this.#writer, generationId, bindings);
	}

	public insertDiagnostics(generationId: string, diagnostics: readonly DiagnosticType[]): void {
		debug('insert diagnostics', {generationId, diagnostics: diagnostics.length});
		const statement = this.#writer.prepare(
			'insert into diagnostic (generation_id, position, category, code, message, path, start_line, start_column) values (?, ?, ?, ?, ?, ?, ?, ?)',
		);

		this.#transaction(() => {
			for (const [index, diagnostic] of diagnostics.entries()) {
				statement.run(
					generationId,
					index,
					diagnostic.category,
					diagnostic.code,
					diagnostic.message,
					diagnostic.path,
					diagnostic.startLine,
					diagnostic.startColumn,
				);
			}
		});
	}

	public putExtractionArtifact(input: ExtractionArtifactKeyType & Readonly<{artifactJson: string}>): void {
		putExtractionArtifact(this.#writer, input);
	}

	public getExtractionArtifact(input: ExtractionArtifactKeyType): string | null {
		return getExtractionArtifact(this.#reader, input);
	}

	public countRows(generationId: string, table: 'file' | 'symbol' | 'occurrence' | 'dependency_edge' | 'dependency_binding' | 'diagnostic'): number {
		const row = this.#reader.prepare(`select count(*) as total from ${table} where generation_id = ?`).get(generationId);
		return row === undefined ? 0 : asNumber(row, 'total');
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
			if (ownerId !== undefined && !ownsLease(this.#writer, {projectId: this.#projectId, ownerId, now: Date.now()})) {
				throw new CodeIndexError('index_build_failed', 'Build lease was lost or expired before publication');
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

	public updateSourceHash(generationId: string, sourceHash: string): void {
		this.#writer.prepare("update generation set source_hash = ? where id = ? and state = 'building'").run(sourceHash, generationId);
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
		const row = this.#reader.prepare(`select ${SYMBOL_COLUMNS} from symbol where generation_id = ? and id = ?`).get(generationId, id);
		return row === undefined ? null : toSymbolSummary(row, listSymbolContexts(this.#reader, generationId, [id]).get(id) ?? []);
	}
	public listOutline(
		input: Readonly<{generationId: string; path: string; kinds: readonly string[]; limit: number; offset: number}>,
	): readonly SymbolSummaryType[] {
		const {generationId, path: pathName, kinds, limit, offset} = input;
		const rows = this.#reader.prepare(outlineQuerySql(kinds.length)).all(generationId, pathName, ...kinds, limit, offset);
		const contexts = listSymbolContexts(
			this.#reader,
			generationId,
			rows.map((row) => asString(row, 'id')),
		);
		debug('list outline', {generationId, path: pathName, kinds, limit, offset, rows: rows.length});
		return rows.map((row) => {
			const id = asString(row, 'id');

			return toSymbolSummary(row, contexts.get(id) ?? []);
		});
	}

	public findSymbols(
		input: Readonly<{generationId: string; query: string; context?: string | undefined; limit: number; offset: number}>,
	): readonly SymbolMatchType[] {
		return findStoredSymbols(this.#reader, input);
	}

	public findReferences(
		input: Readonly<{
			generationId: string;
			symbolId: string;
			role: 'definition' | 'reference' | undefined;
			context?: string | undefined;
			limit: number;
			offset: number;
		}>,
	): readonly ReferenceType[] {
		return findStoredReferences(this.#reader, input);
	}

	public findDependencyEdgesByPackage(generationId: string, packageName: string, context?: string): readonly StoredDependencyEdgeType[] {
		return findDependencyEdgesByPackage(this.#reader, generationId, packageName, context);
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
