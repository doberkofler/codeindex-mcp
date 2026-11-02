import {type FinalizedFactSetType} from '../facts/types.ts';
import {
	type DiagnosticType,
	type IndexedDependencyBindingType,
	type IndexedDependencyEdgeType,
	type ScanProjectResultType,
	type SourceFileType,
} from '../model.ts';

type AdapterCoverageType = 'present' | 'absent';

/** Stable per-adapter counts persisted on `generation_adapter`. */
export type AdapterCommitCountsType = Readonly<{
	readonly files: number;
	readonly symbols: number;
	readonly occurrences: number;
	readonly dependencyEdges: number;
	readonly dependencyBindings: number;
	readonly diagnostics: number;
}>;

/**
 * One adapter's contribution to a multi-adapter publication.
 *
 * A present adapter always supplies a complete file manifest. Facts are present
 * only when the adapter must rewrite them; absent facts mean the published fact
 * rows remain authoritative for this adapter.
 */
export type AdapterCommitType = Readonly<{
	readonly adapterId: string;
	readonly adapterVersion: string;
	readonly compilerVersion: string;
	readonly declaredCompilerVersion: string | null;
	readonly compilerDrift: boolean;
	readonly coverage: AdapterCoverageType;
	readonly absenceReason: string | null;
	readonly sourceHash: string;
	readonly configHash: string;
	readonly inputHash: string;
	readonly counts: AdapterCommitCountsType;
	readonly stages: Readonly<{scanMs: number; compilerMs: number; extractionMs: number}>;
	readonly files: readonly SourceFileType[];
	readonly projects: readonly ScanProjectResultType[];
	readonly facts?: FinalizedFactSetType | undefined;
	readonly dependencies?: Readonly<{
		readonly edges: readonly IndexedDependencyEdgeType[];
		readonly bindings: readonly IndexedDependencyBindingType[];
	}>;
	readonly diagnostics?: readonly DiagnosticType[] | undefined;
}>;

/** One multi-adapter publication applied in a single transaction. */
export type MultiGenerationCommitInputType = Readonly<{
	readonly generationId: string;
	readonly adapters: readonly AdapterCommitType[];
	/** Adapters removed from configuration; their rows are deleted. */
	readonly removedAdapterIds?: readonly string[] | undefined;
	readonly sourceHash: string;
	readonly configHash: string;
	readonly inputHash: string;
	/** ISO start of this revision; keeps `started_at` describing one attempt. */
	readonly startedAt?: string | undefined;
	readonly ownerId?: string | undefined;
	/** Building-generation insert or published-generation revision. */
	readonly mode?: 'insert' | 'revise' | undefined;
}>;
