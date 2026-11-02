import {type FinalizedFactSetType} from '../facts/types.ts';
import {
	type DiagnosticType,
	type IndexedDependencyBindingType,
	type IndexedDependencyEdgeType,
	type ScanProjectResultType,
	type SourceFileType,
} from '../model.ts';

/** Complete serializable fact set stored by one generation persistence call. */ export type GenerationFactsInputType = Readonly<{
	readonly generationId: string;
	/** Adapter that owns every row in this write; defaults to `language`. */
	readonly adapterId?: string;
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
	readonly writtenRows: number;
}>;

/** Accepted generation states for one fact write. */
export type GenerationFactWriteModeType = 'insert' | 'revise';

/**
 * Resolves the adapter that owns one fact write.
 *
 * Older callers pass only `language`; the adapter identity defaults to it so the
 * singular path keeps one source of truth.
 *
 * @param input - Fact write input.
 * @returns The owning adapter identifier.
 */
export const adapterIdOf = (input: Readonly<{adapterId?: string | undefined; language: string}>): string => input.adapterId ?? input.language;
