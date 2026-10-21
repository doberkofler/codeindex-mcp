export type GenerationStateType = 'building' | 'published' | 'superseded' | 'failed';

export type RefreshStateType = 'current' | 'dirty' | 'building' | 'failed' | 'unknown' | 'stopping';

type QueryFreshnessStateType = 'current' | 'updating' | 'stale' | 'unknown';

export type QueryFreshnessType = Readonly<{
	readonly state: QueryFreshnessStateType;
	readonly checkedAt: string;
	readonly dirtyFileCount: number | null;
}>;

export type SourceFileType = Readonly<{
	readonly path: string;
	readonly absolutePath: string;
	readonly sha256: string;
	readonly byteCount: number;
	readonly lineCount: number;
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
	readonly scanMs: number;
	readonly compilerMs: number;
	readonly extractionMs: number;
	readonly insertionMs: number;
	readonly verificationMs: number;
	readonly publicationMs: number;
}>;

export type ScanProjectResultType = Readonly<{
	readonly name: string;
	/** Workspace-relative POSIX path to the project file. */
	readonly projectFile: string;
	readonly configHash: string;
	readonly projectFileCount: number;
	readonly configDiagnosticCount: number;
}>;

export type ScanResultType = Readonly<{
	readonly rootDir: string;
	readonly projectId: string;
	readonly extractorId: string;
	readonly extractorVersion: string;
	readonly compilerVersion: string;
	readonly declaredCompilerVersion: string | null;
	readonly compilerDrift: boolean;
	readonly files: readonly SourceFileType[];
	readonly sourceHash: string;
	readonly configHash: string;
	readonly projects: readonly ScanProjectResultType[];
	readonly projectFileCount: number;
	readonly excludedFileCount: number;
	readonly configDiagnosticCount: number;
	readonly scanMs: number;
}>;

export type DiagnosticType = Readonly<{
	readonly category: 'error' | 'warning' | 'suggestion' | 'message';
	readonly code: number;
	readonly message: string;
	readonly path: string | null;
	readonly startLine: number | null;
	readonly startColumn: number | null;
}>;

export type IndexedSymbolType = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly kind: string;
	readonly path: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly enclosingId: string | null;
	/**
	 * External module target for a synthetic authored alias.
	 *
	 * Authored declarations leave both external fields absent.
	 */
	readonly externalTarget?: string | null | undefined;
	/** Imported external name (`*` for a namespace, `default` for a default alias). */
	readonly externalName?: string | null | undefined;
	/** Compiler contexts that produced this declaration. */
	readonly contexts?: readonly string[] | undefined;
}>;

export type IndexedOccurrenceType = Readonly<{
	readonly symbolId: string;
	readonly path: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly role: 'definition' | 'reference';
	readonly enclosingId: string | null;
	/**
	 * Usage bitmask for a reference: `call` 1, `read` 2, `write` 4,
	 * `type_ref` 8. Definitions use zero and absent values default to zero.
	 */
	readonly usage?: number | undefined;
	/** Compiler contexts that resolved this occurrence. */
	readonly contexts?: readonly string[] | undefined;
}>;

export type ExtractionResultType = Readonly<{
	readonly symbols: readonly IndexedSymbolType[];
	readonly occurrences: readonly IndexedOccurrenceType[];
	readonly diagnostics: readonly DiagnosticType[];
	readonly diagnosticCount: number;
}>;

/**
 * Adapter-defined dependency kind.
 *
 * The core stores and filters the value but does not interpret it. Adapters emit
 * bounded, non-empty lower-case identifiers such as `import` or `package-call`.
 */
export type DependencyKindType = string;

/**
 * Adapter-defined dependency binding kind.
 *
 * The core stores the value but does not interpret it.
 */
type DependencyBindingKindType = string;

export type IndexedDependencyEdgeType = Readonly<{
	readonly id: string;
	readonly context?: string | undefined;
	readonly sourcePath: string;
	readonly targetPath: string | null;
	readonly rawTarget: string;
	readonly targetIdentifier: string | null;
	readonly kind: DependencyKindType;
	readonly compileTimeOnly: boolean;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly startOffset: number;
	readonly endOffset: number;
}>;

export type IndexedDependencyBindingType = Readonly<{
	readonly edgeId: string;
	readonly position: number;
	readonly kind: DependencyBindingKindType;
	readonly importedName: string | null;
	readonly exportedName: string | null;
	readonly localName: string | null;
	readonly compileTimeOnly: boolean;
}>;

export type DependencyExtractionResultType = Readonly<{
	readonly edges: readonly IndexedDependencyEdgeType[];
	readonly bindings: readonly IndexedDependencyBindingType[];
}>;

export type StoredDependencyEdgeType = IndexedDependencyEdgeType & Readonly<{readonly generationId: string}>;

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
	readonly direction?: 'consumers' | undefined;
	readonly transitive?: boolean | undefined;
	readonly root?: string | undefined;
	readonly detail?: DependencyDetailType | undefined;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

export type GenerationRowType = Readonly<{
	readonly id: string;
	readonly state: GenerationStateType;
	readonly extractorId: string;
	readonly extractorVersion: string;
	readonly compilerVersion: string;
	readonly sourceHash: string;
	readonly configHash: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
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
	readonly state: GenerationStateType;
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

export type IndexStatusType = Readonly<{
	readonly ready: boolean;
	readonly state: GenerationStateType | 'absent';
	readonly refresh: RefreshStateType;
	readonly generationId: string | null;
	readonly building: boolean;
	readonly scope: Readonly<{
		readonly root: string;
		readonly projectName: string;
		readonly projectFile: string;
		readonly projects: readonly Readonly<{readonly name: string; readonly projectFile: string}>[];
		readonly extractor: Readonly<{
			readonly id: string;
			readonly version: string;
			readonly compilerVersion: string;
		}>;
		readonly projectId: string;
		readonly workingCopyId: string | null;
	}>;
	readonly hashes: Readonly<{
		readonly source: string | null;
		readonly configuration: string | null;
	}>;
	readonly counts: Readonly<{
		readonly files: number;
		readonly symbols: number;
		readonly occurrences: number;
		readonly dependencyEdges: number;
		readonly dependencyBindings: number;
		readonly diagnostics: number;
	}>;
	readonly buildStats: readonly BuildStatType[];
	readonly build: Readonly<{
		readonly startedAt: string | null;
		readonly completedAt: string | null;
		readonly durationMs: number | null;
		readonly stages: BuildStagesType | null;
	}>;
	readonly freshness: QueryFreshnessType &
		Readonly<{
			readonly staleFiles: number;
			readonly sourceChanged: boolean | null;
		}>;
	readonly lease: BuildLeaseType | null;
	readonly exclusions: readonly string[];
	readonly lastError: string | null;
}>;

/** Bounded status projection for the default MCP response. */
export type IndexStatusSummaryType = Readonly<{
	readonly ready: boolean;
	readonly state: IndexStatusType['state'];
	readonly refresh: IndexStatusType['refresh'];
	readonly generationId: string | null;
	readonly building: boolean;
	readonly scope: Readonly<{
		readonly projectName: string;
		readonly contexts: readonly string[];
		readonly extractor: IndexStatusType['scope']['extractor'];
	}>;
	readonly counts: IndexStatusType['counts'];
	readonly freshness: IndexStatusType['freshness'];
	readonly lastError: string | null;
}>;

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
