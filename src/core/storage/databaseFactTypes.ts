import {type FinalizedFactSetType} from '../facts/types.ts';
import {
	type DiagnosticType,
	type IndexedDependencyBindingType,
	type IndexedDependencyEdgeType,
	type ScanProjectResultType,
	type SourceFileType,
} from '../model.ts';

/** Complete serializable fact set stored by one generation persistence call. */
export type GenerationFactsInputType = Readonly<{
	readonly generationId: string;
	/** Adapter that owns every row in this write; supplied by core, never by the bundle. */
	readonly adapterId: string;
	/** Adapter identifier used as the closed `build_stats.language` value. */
	readonly language: string;
	readonly files: readonly SourceFileType[];
	readonly projects: readonly ScanProjectResultType[];
	readonly facts: FinalizedFactSetType;
	readonly dependencies: Readonly<{
		readonly edges: readonly IndexedDependencyEdgeType[];
		readonly bindings: readonly IndexedDependencyBindingType[];
	}>;
	readonly diagnostics: readonly DiagnosticType[];
	readonly sourceHash: string;
}>;

/** Rows persisted by one generation fact insertion. */
export type GenerationFactCountsType = Readonly<{
	readonly files: number;
	readonly symbols: number;
	readonly bindings: number;
	readonly bindingContexts: number;
	readonly bindingSites: number;
	readonly surfaceOrigins: number;
	readonly occurrences: number;
	readonly definitionSites: number;
	readonly dependencyEdges: number;
	readonly dependencyBindings: number;
	readonly diagnostics: number;
	readonly buildStats: number;
}>;

/** One fact write and the paths whose persisted fact rows changed. */
export type GenerationFactWriteType = Readonly<{
	readonly counts: GenerationFactCountsType;
	readonly changedPaths: readonly string[];
	/** Adapter-owned rows selected for insertion after path filtering. */
	readonly selectedRows: number;
	/** Adapter-owned rows removed directly or by cascades before insertion. */
	readonly deletedRows: number;
	/** Adapter-owned rows actually inserted or updated. */
	readonly writtenRows: number;
}>;

/** Accepted generation states for one fact write. */
export type GenerationFactWriteModeType = 'insert' | 'revise';

/**
 * Resolves the adapter that owns one fact write.
 *
 * The identifier is always attached by core at ingestion; an adapter bundle
 * cannot self-declare it.
 *
 * @param input - Fact write input.
 * @returns The owning adapter identifier.
 */
export const adapterIdOf = (input: Readonly<{adapterId: string}>): string => input.adapterId;
