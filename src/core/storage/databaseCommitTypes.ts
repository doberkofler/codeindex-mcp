import {type FinalizedFactSetType} from '../facts/types.ts';
import {type GenerationFactsInputType, type GenerationFactWriteModeType} from './databaseFactTypes.ts';
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
	readonly protocolVersion: number;
	readonly adapterVersion: string;
	readonly packageName: string | null;
	readonly packageVersion: string | null;
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

/**
 * Per-adapter provenance supplied by the singular commit path.
 *
 * Multi-adapter publication supplies the same fields through
 * {@link AdapterCommitType}; neither path projects them onto `generation`.
 */
type AdapterProvenanceType = Readonly<{
	readonly adapterId: string;
	readonly protocolVersion: number;
	readonly adapterVersion: string;
	readonly packageName: string | null;
	readonly packageVersion: string | null;
	readonly compilerVersion: string;
	readonly declaredCompilerVersion: string | null;
	readonly compilerDrift: boolean;
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
	GenerationCommitBaseType &
	Readonly<{readonly provenance: AdapterProvenanceType}>;
