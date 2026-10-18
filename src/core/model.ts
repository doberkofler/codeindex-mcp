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
}>;

export type ExtractionResultType = Readonly<{
	readonly symbols: readonly IndexedSymbolType[];
	readonly occurrences: readonly IndexedOccurrenceType[];
	readonly diagnostics: readonly DiagnosticType[];
	readonly diagnosticCount: number;
}>;

export type DependencyKindType = 'import' | 'side-effect' | 'export' | 'export-all' | 'dynamic-import' | 'import-type' | 'import-equals';

export type DependencyBindingKindType = 'default' | 'named' | 'namespace' | 'all' | 'import-equals';

export type IndexedDependencyEdgeType = Readonly<{
	readonly id: string;
	readonly sourcePath: string;
	readonly targetPath: string | null;
	readonly rawSpecifier: string;
	readonly normalizedPackage: string | null;
	readonly kind: DependencyKindType;
	readonly typeOnly: boolean;
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
	readonly typeOnly: boolean;
}>;

export type DependencyExtractionResultType = Readonly<{
	readonly edges: readonly IndexedDependencyEdgeType[];
	readonly bindings: readonly IndexedDependencyBindingType[];
}>;

export type StoredDependencyEdgeType = IndexedDependencyEdgeType & Readonly<{readonly generationId: string}>;

export type DependencyEvidenceBindingType = Omit<IndexedDependencyBindingType, 'edgeId' | 'position'>;

type DependencyEvidenceType = Readonly<{
	readonly targetPath: string | null;
	readonly rawSpecifier: string;
	readonly normalizedPackage: string | null;
	readonly kind: DependencyKindType;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly bindings: readonly DependencyEvidenceBindingType[];
}>;

type DependencyQueryMeaningType = 'direct_usage' | 'module_impact';

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

type DependencyRootSummaryType = Readonly<{
	readonly path: string;
	readonly consumerCount: number;
}>;

export type FindDependenciesInputType = Readonly<{
	readonly package: string;
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

export type SymbolSummaryType = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly kind: string;
	readonly path: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly enclosingId: string | null;
}>;

export type OutlineInputType = Readonly<{
	readonly path: string;
	readonly kinds?: readonly string[] | undefined;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

type PagedResultType<ItemType> = Readonly<{
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly items: readonly ItemType[];
	readonly nextCursor: string | null;
	readonly truncated: boolean;
}>;

export type OutlineResultType = PagedResultType<SymbolSummaryType>;

export type FindSymbolInputType = Readonly<{
	readonly query: string;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

export type SymbolMatchType = SymbolSummaryType &
	Readonly<{
		readonly match: 'exact_qualified' | 'exact_name' | 'prefix_qualified' | 'prefix_name';
	}>;

export type FindSymbolResultType = PagedResultType<SymbolMatchType>;

export type FindReferencesInputType = Readonly<{
	readonly symbolId: string;
	readonly role?: 'definition' | 'reference' | undefined;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

export type ReferenceType = Readonly<{
	readonly path: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly role: 'definition' | 'reference';
	readonly enclosingId: string | null;
}>;

export type FindReferencesResultType = PagedResultType<ReferenceType>;

export type FindDependenciesResultType = PagedResultType<DependencyConsumerItemType> &
	Readonly<{
		readonly queryMeaning: DependencyQueryMeaningType;
		readonly summary: Readonly<{
			readonly totalConsumers: number;
			readonly directConsumers: number;
			readonly transitiveConsumers: number;
			readonly roots: readonly DependencyRootSummaryType[];
		}>;
	}>;

export type ReadSymbolInputType = Readonly<{
	readonly symbolId: string;
	readonly contextLines: number;
}>;

export type ReadSymbolResultType = Readonly<{
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly symbol: SymbolSummaryType;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly source: string;
	readonly truncated: boolean;
	readonly truncatedReason: 'lines' | 'bytes' | null;
}>;
