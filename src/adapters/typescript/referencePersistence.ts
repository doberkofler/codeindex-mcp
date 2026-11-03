import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {type ExtractorBuildType} from '../types.ts';
import {ADAPTER_PROTOCOL_VERSION, type AdapterConfigType} from '@codeindex/adapter-sdk';
import {PUBLICATION_SURFACE_BINDINGS_PER_ROOT, finalizeFacts} from '../../core/facts/index.ts';
import {type ReferencePartitionScopeType, type ScanResultType} from '../../core/model.ts';
import {findReferences as queryReferences, type QueryContextType} from '../../core/query/queryService.ts';
import {computeSourceHash} from '../../core/generation/sourceFiles.ts';
import {IndexDatabase} from '../../core/storage/database.ts';
import {scopedFactIdOf} from '../../core/storage/factIdentity.ts';
import {type ReferenceLocationType} from './referenceLocations.ts';
import {type ReferencePersistenceType} from './referenceGate.ts';

/** Page size used to prove cursor pagination rather than a single bulk read. */
const PAGE_LIMIT = 3;
const MAX_PAGES_PER_SYMBOL = 100_000;

export type PersistedReferenceReaderType = Readonly<{
	/**
	 * Reads every persisted occurrence for one symbol through the real query
	 * surface. Passing `external_alias_group` reads the whole group from one
	 * seed, including page boundaries.
	 */
	readAll: (symbolId: string, scope?: ReferencePartitionScopeType) => readonly ReferenceLocationType[];
}>;

const locationOf = (item: Readonly<{path: string; startOffset: number; endOffset: number; role: 'definition' | 'reference'}>): ReferenceLocationType => ({
	path: item.path,
	startOffset: item.startOffset,
	endOffset: item.endOffset,
	role: item.role,
});

const readAllPages = (
	context: QueryContextType,
	symbolId: string,
	scope: ReferencePartitionScopeType | undefined,
	maxResultBytes: number,
): Readonly<{locations: readonly ReferenceLocationType[]; pages: number}> => {
	const locations: ReferenceLocationType[] = [];
	let cursor: string | undefined;
	let pages = 0;

	do {
		pages += 1;

		if (pages > MAX_PAGES_PER_SYMBOL) {
			throw new Error(`Persisted reference query did not terminate for symbol ${symbolId}`);
		}

		const result = queryReferences(
			context,
			{
				symbolId,
				group: 'occurrence',
				limit: PAGE_LIMIT,
				...(scope === undefined ? {} : {scope}),
				...(cursor === undefined ? {} : {cursor}),
			},
			maxResultBytes,
		);

		if (result.kind !== 'occurrences') {
			throw new Error(`Persisted reference query returned ${result.kind} for symbol ${symbolId}`);
		}

		for (const item of result.items) {
			locations.push(locationOf(item));
		}

		cursor = result.nextCursor ?? undefined;
	} while (cursor !== undefined);

	return {locations, pages};
};

/**
 * Persists one extracted fact set into an isolated database and reads it back.
 *
 * The database is temporary and owns the production commit path, so the
 * verifier compares language-service truth against exactly what
 * `find_references` returns, including cursor pagination and byte bounds.
 *
 * @param input - Configuration, scan, and extracted facts.
 * @param action - Callback receiving the persisted reader.
 * @returns The callback value and measured pagination metadata.
 */
export const withPersistedReferenceIndex = <ValueType>(
	input: Readonly<{config: AdapterConfigType; scan: ScanResultType; facts: ExtractorBuildType}>,
	action: (reader: PersistedReferenceReaderType) => ValueType,
): Readonly<{value: ValueType; persistence: ReferencePersistenceType}> => {
	const directory = mkdtempSync(path.join(tmpdir(), 'codeindex-reference-verify-'));
	const database = IndexDatabase.open(path.join(directory, 'index.sqlite'), {
		rootDir: input.config.rootDir,
		projectFilePath: input.config.projectFilePath,
		projectId: input.config.projectId,
		extractorId: input.config.extractorId,
	});
	const counters = {pages: 0, symbols: 0};

	try {
		const generationId = randomUUID();
		const finalized = finalizeFacts(input.facts, {
			mode: 'enforce',
			maxBindingsPerRoot: PUBLICATION_SURFACE_BINDINGS_PER_ROOT,
			extractorId: input.scan.extractorId,
		});

		database.createGeneration({
			id: generationId,
			sourceHash: input.scan.sourceHash,
			configHash: input.scan.configHash,
			...(input.scan.inputHash === undefined ? {} : {inputHash: input.scan.inputHash}),
		});
		database.commitGeneration({
			mode: 'insert',
			reuseFacts: false,
			generationId,
			adapterId: input.scan.extractorId,
			provenance: {
				adapterId: input.scan.extractorId,
				protocolVersion: ADAPTER_PROTOCOL_VERSION,
				adapterVersion: input.scan.extractorVersion,
				packageName: null,
				packageVersion: null,
				compilerVersion: input.scan.compilerVersion,
				declaredCompilerVersion: input.scan.declaredCompilerVersion,
				compilerDrift: input.scan.compilerDrift,
			},
			language: input.scan.extractorId,
			files: input.facts.files,
			projects: input.scan.projects,
			facts: finalized,
			dependencies: input.facts.dependencies,
			diagnostics: input.facts.diagnostics,
			sourceHash: computeSourceHash(input.facts.files),
			configHash: input.scan.configHash,
			...(input.scan.inputHash === undefined ? {} : {inputHash: input.scan.inputHash}),
			stages: {scanMs: input.scan.scanMs, compilerMs: input.facts.compilerMs, extractionMs: input.facts.extractionMs},
		});

		const published = database.getPublishedGeneration();

		if (published === null) {
			throw new Error('Reference verification failed to publish its temporary generation');
		}

		const context: QueryContextType = {
			database,
			generationId: published.id,
			freshness: {state: 'current', checkedAt: new Date().toISOString(), dirtyFileCount: 0},
			adapters: [input.scan.extractorId],
			normalizers: new Map(),
		};
		const reader: PersistedReferenceReaderType = {
			readAll: (symbolId, scope) => {
				counters.symbols += 1;
				const page = readAllPages(context, scopedFactIdOf(input.scan.extractorId, symbolId), scope, input.config.maxResultBytes);
				counters.pages += page.pages;
				return page.locations;
			},
		};
		const value = action(reader);

		return {value, persistence: {pageLimit: PAGE_LIMIT, pages: counters.pages, symbols: counters.symbols}};
	} finally {
		database.close();
		rmSync(directory, {recursive: true, force: true});
	}
};
