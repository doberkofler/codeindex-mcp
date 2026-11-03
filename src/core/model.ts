import {type DependencyKindType, type IndexedDependencyBindingType, type IndexedDependencyEdgeType} from '@codeindex/adapter-sdk';

export type {
	DiagnosticType,
	DependencyExtractionResultType,
	DependencyKindType,
	ExtractionResultType,
	IndexedDependencyBindingType,
	IndexedDependencyEdgeType,
	IndexedOccurrenceType,
	IndexedSymbolType,
	ScanProjectResultType,
	ScanResultType,
	SourceFileType,
} from '@codeindex/adapter-sdk';

export type GenerationStateType = 'building' | 'published' | 'superseded' | 'failed';

/** Closed outcome of one build attempt. */
export type BuildOutcomeType = 'reused' | 'published' | 'superseded' | 'failed';

export type RefreshStateType = 'current' | 'dirty' | 'building' | 'failed' | 'unknown' | 'stopping';

type QueryFreshnessStateType = 'current' | 'updating' | 'stale' | 'unknown';

export type QueryFreshnessType = Readonly<{
	readonly state: QueryFreshnessStateType;
	readonly checkedAt: string;
	readonly dirtyFileCount: number | null;
}>;

export type VcsKindType = 'git' | 'svn' | 'none';

export type VcsProvenanceType = Readonly<{
	readonly kind: VcsKindType;
	readonly repository: string | null;
	readonly revision: string | null;
	readonly relativeRoot: string | null;
}>;

export type WorkingCopyIdentityType = Readonly<{
	readonly id: string;
	readonly canonicalRoot: string;
	readonly vcs: VcsProvenanceType;
	readonly createdAt: string;
	readonly lastSeenAt: string;
}>;

export type BuildLeaseType = Readonly<{
	readonly projectId: string;
	readonly ownerId: string;
	readonly processId: number;
	readonly acquiredAt: string;
	readonly heartbeatAt: string;
	readonly expiresAt: string;
}>;

export type BuildStagesType = Readonly<{
	/** Workspace scan; excludes every later stage. */
	readonly scanMs: number;
	/** Compiler or parser load; excluded from `extractionMs`. */
	readonly compilerMs: number;
	/** Fact extraction after `compilerMs`; the stages partition the attempt. */
	readonly extractionMs: number;
	readonly insertionMs: number;
	readonly verificationMs: number;
	readonly publicationMs: number;
}>;

export type StoredDependencyEdgeType = IndexedDependencyEdgeType &
	Readonly<{
		readonly generationId: string;
		/** Adapter that owns the authored source path. */
		readonly adapterId: string;
	}>;

export type DependencyEvidenceBindingType = Omit<IndexedDependencyBindingType, 'edgeId' | 'position'>;

type DependencyEvidenceType = Readonly<{
	readonly targetPath: string | null;
	readonly rawTarget: string;
	readonly targetIdentifier: string | null;
	readonly kind: DependencyKindType;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly context: string | null;
	readonly bindings: readonly DependencyEvidenceBindingType[];
}>;

export type DependencyQueryMeaningType = 'direct_usage' | 'dependency_impact';

type DependencyDetailType = 'compact' | 'evidence';

export type DependencyConsumerType = Readonly<{
	readonly path: string;
	readonly depth: number;
	readonly directRoot: string;
	/** Adapter that owns the direct consumer path. */
	readonly adapter: string;
}>;

export type DependencyEvidenceConsumerType = DependencyConsumerType &
	Readonly<{
		readonly relationship: 'direct' | 'transitive';
		readonly evidenceCount: number;
		readonly evidence: DependencyEvidenceType;
	}>;

export type DependencyConsumerItemType = DependencyConsumerType | DependencyEvidenceConsumerType;

export type DependencyRootSummaryType = Readonly<{
	readonly path: string;
	readonly consumerCount: number;
}>;

export type FindDependenciesInputType = Readonly<{
	/**
	 * Canonical directly queryable external or logical target, such as an npm
	 * package name or an Oracle `SCHEMA.PACKAGE` identifier.
	 */
	readonly target: string;
	readonly context?: string | undefined;
	/** Optional adapter filter; omitted searches every configured adapter. */
	readonly adapter?: string | undefined;
	readonly direction?: 'consumers' | undefined;
	readonly transitive?: boolean | undefined;
	readonly root?: string | undefined;
	readonly detail?: DependencyDetailType | undefined;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

/** Stages measured per adapter; publication stages are generation-wide. */
export type AdapterStagesType = Pick<BuildStagesType, 'scanMs' | 'compilerMs' | 'extractionMs'>;

/** Persisted provenance for one adapter within one generation. */
export type GenerationAdapterType = Readonly<{
	readonly adapterId: string;
	readonly adapterVersion: string;
	readonly compilerVersion: string;
	readonly declaredCompilerVersion: string | null;
	readonly compilerDrift: boolean;
	readonly coverage: 'present' | 'absent';
	readonly absenceReason: string | null;
	readonly sourceHash: string;
	readonly configHash: string;
	readonly inputHash: string;
	readonly fileCount: number;
	readonly symbolCount: number;
	readonly occurrenceCount: number;
	readonly dependencyEdgeCount: number;
	readonly dependencyBindingCount: number;
	readonly diagnosticCount: number;
	readonly stages: AdapterStagesType | null;
}>;

export type GenerationRowType = Readonly<{
	readonly id: string;
	readonly state: GenerationStateType;
	readonly extractorId: string;
	readonly extractorVersion: string;
	/** Compiler or parser runtime version that produced the facts. */
	readonly compilerVersion: string;
	/** Compiler version declared by the project, when the adapter can resolve one. */
	readonly declaredCompilerVersion: string | null;
	/** True when the runtime major differs from the declared compiler major. */
	readonly compilerDrift: boolean;
	readonly sourceHash: string;
	readonly configHash: string;
	/** Hash over declarations and module-resolution inputs; empty for legacy rows. */
	readonly inputHash?: string;
	/** Start of the latest published revision, not the lifetime of the generation row. */
	readonly startedAt: string;
	readonly completedAt: string | null;
	/** Monotonic publication counter; increments on every successful revision. */
	readonly revision: number;
	readonly fileCount: number;
	readonly symbolCount: number;
	readonly occurrenceCount: number;
	readonly dependencyEdgeCount: number;
	readonly dependencyBindingCount: number;
	readonly diagnosticCount: number;
	readonly stages: BuildStagesType | null;
	readonly error: string | null;
}>;

export type BuildReportType = Readonly<{
	readonly generationId: string;
	readonly revision: number;
	readonly state: GenerationStateType;
	/** Closed attempt outcome; `failed` is carried by a structured error instead. */
	readonly outcome: Exclude<BuildOutcomeType, 'failed'>;
	readonly reused: boolean;
	readonly durationMs: number;
	readonly fileCount: number;
	readonly symbolCount: number;
	readonly occurrenceCount: number;
	readonly dependencyEdgeCount: number;
	readonly dependencyBindingCount: number;
	readonly diagnosticCount: number;
	readonly stages: BuildStagesType | null;
}>;

export type IndexVerificationType = Readonly<{
	readonly generationId: string;
	readonly integrity: 'ok';
	readonly metadataMatches: boolean;
	readonly counts: Readonly<{
		readonly files: number;
		readonly symbols: number;
		readonly occurrences: number;
		readonly dependencyEdges: number;
		readonly dependencyBindings: number;
		readonly diagnostics: number;
	}>;
}>;

export type BuildStatType = Readonly<{
	readonly language: string;
	readonly metric: string;
	readonly dim1: string;
	readonly dim2: string;
	readonly dim3: string;
	readonly value: number;
}>;

export type {IndexStatusSummaryType, IndexStatusType} from './modelStatus.ts';

export type {
	SymbolSummaryType,
	BindingExposureType,
	ContextExposureType,
	BindingSiteKindType,
	BindingSiteSummaryType,
	DefinitionSiteSummaryType,
	BindingSummaryType,
	BindingDetailType,
	FindSymbolItemType,
	OutlineReexportType,
	OutlineInputType,
	OutlineResultType,
	FindSymbolInputType,
	FindSymbolResultType,
	ExactNamePresenceType,
	FindReferencesInputType,
	ReferenceGroupModeType,
	ReferencePartitionScopeType,
	ReferenceCompletenessType,
	ReferencePartitionMemberType,
	ReferencePartitionType,
	ReferenceOwnerSummaryType,
	ReferenceType,
	ReferenceGroupType,
	ReferenceOwnerGroupType,
	ReferenceCandidateType,
	FindReferencesOccurrencesResultType,
	QueryFindReferencesResultType,
	FindReferencesResultType,
	SymbolIdFindReferencesInputType,
	SymbolIdGroupedFindReferencesInputType,
	SymbolIdGroupedFindReferencesResultType,
	QueryFindReferencesInputType,
	FindDependenciesResultType,
	ReadSymbolInputType,
	ReadSymbolTextResultType,
	ReadSymbolResultType,
	SymbolAtInputType,
	SymbolAtResultType,
} from './modelPublication.ts';
