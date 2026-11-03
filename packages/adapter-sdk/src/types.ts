/** Language-neutral adapter protocol types. */

/** One project context owned by an adapter. */
export type ProjectContextConfigType = Readonly<{
	readonly name: string;
	readonly projectFilePath: string;
}>;

/** One configured adapter entry. */
export type ConfiguredAdapterType = Readonly<{
	readonly id: string;
	/** Required adapters fail the candidate; optional adapters may be absent. */
	readonly required: boolean;
	/**
	 * Explicit adapter module specifier.
	 *
	 * A bare package name resolves from the configuration location; a relative
	 * path resolves from the configuration directory. Absent entries normalise
	 * through the host's compatibility alias map.
	 */
	readonly module?: string | undefined;
	readonly options: Readonly<Record<string, unknown>>;
	/** First configured project; retained for single-project surfaces. */
	readonly projectFilePath: string;
	readonly projects: readonly ProjectContextConfigType[];
}>;

/**
 * Narrow adapter-facing configuration.
 *
 * The host configuration is structurally assignable to this shape. Adapters do
 * not receive storage paths, analytics settings, or any other host concern.
 */
export type AdapterConfigType = Readonly<{
	readonly projectName: string;
	readonly rootDir: string;
	readonly projectId: string;
	readonly extractorId: string;
	readonly extractorOptions: Readonly<Record<string, unknown>>;
	readonly projectFilePath: string;
	readonly projects: readonly ProjectContextConfigType[];
	readonly semanticDiagnostics: boolean;
	readonly maxResultBytes: number;
	readonly maxReadLines: number;
	/** Every configured adapter; retained for adapters that mirror host options. */
	readonly adapters?: readonly ConfiguredAdapterType[] | undefined;
}>;

export type SourceFileType = Readonly<{
	readonly path: string;
	readonly absolutePath: string;
	readonly sha256: string;
	readonly byteCount: number;
	readonly lineCount: number;
	/**
	 * Bytes captured by the adapter for the exact parsed version.
	 *
	 * Storage verifies these bytes instead of rereading the filesystem, so the
	 * persisted content cannot describe a later file version.
	 */
	readonly content?: Uint8Array;
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
	/**
	 * Hash over non-authored inputs that can change extracted facts.
	 *
	 * Authored source bytes are already covered by `sourceHash`; this covers
	 * declarations, configuration chains, package manifests, lockfiles, and
	 * module-resolution probes. Adapters that do not distinguish the two use
	 * `configHash`.
	 */
	readonly inputHash?: string;
	/** Absolute files that can change the manifest, used by the workspace watcher. */
	readonly watchInputs?: readonly string[];
	/**
	 * Configuration identity for per-file extraction artifacts.
	 *
	 * Adapters set this when artifact validity does not depend on source content.
	 * It defaults to `configHash` when absent.
	 */
	readonly artifactContextHash?: string;
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

/** Adapter-defined dependency binding kind. */
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

/** Source range carried by one declaration or binding site. */
export type FactRangeType = Readonly<{
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly startOffset: number;
	readonly endOffset: number;
}>;

/**
 * One typed address segment.
 *
 * Adapters choose the legal kinds and values for their language. The core
 * validates only the generic tuple shape and serializes the vector.
 */
export type FactAddressSegmentType = readonly [kind: string, value: string | number | null];

/** Ordered address segments for one searchable binding. */
export type FactAddressType = readonly FactAddressSegmentType[];

/** Exposure of one binding in one project context. */
export type FactExposureType = 'published' | 'reachable' | 'internal';

/** Exposure derived for a symbol from all of its binding contexts. */
export type SymbolExposureType = 'published' | 'reachable' | 'internal_only';

/** Source form that introduced one binding. */
export type FactSiteKindType = 'declared' | 'alias' | 'default' | 'reexport' | 'wildcard' | 'commonjs' | 'surface';

/** Adapter-defined aggregate statistic. */
export type AdapterStatType = Readonly<{
	readonly metric: string;
	readonly value: number;
	readonly dimensions?: readonly string[] | undefined;
}>;

/**
 * Definition occurrence enriched with the ranking and extent inputs owned by an
 * adapter.
 *
 * Reference occurrences leave every optional field absent. The core finalizer
 * selects one identity anchor and one primary definition per symbol from these
 * fields.
 */
export type ExtractedOccurrenceType = IndexedOccurrenceType &
	Readonly<{
		/** Declaration form at this definition occurrence. */
		readonly declarationKind?: string | undefined;
		readonly forwardDefinition?: boolean | undefined;
		/** Declaration extent, which may be wider than the name range. */
		readonly extent?: FactRangeType | undefined;
		readonly anchorRank?: number | undefined;
		readonly primaryRank?: number | undefined;
	}>;

/** One searchable binding before the core derives its canonical key and ID. */
export type ExtractedBindingType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
}>;

/** Exposure of one binding in one project context. */
export type ExtractedBindingContextType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly context: string;
	readonly exposure: FactExposureType;
}>;

/** One authored source site that introduces or projects a binding. */
export type ExtractedBindingSiteType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly kind: FactSiteKindType;
	readonly path: string;
	readonly range: FactRangeType;
}>;

/**
 * Published root and relative address path for one surface binding.
 *
 * The moved address is validated against `rootSegments + relativeSegments`.
 */
export type ExtractedSurfaceOriginType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly context: string;
	readonly rootSymbolId: string;
	readonly rootSegments: FactAddressType;
	readonly relativeSegments: FactAddressType;
}>;

/** Binding facts emitted by one adapter for one generation. */
export type ExtractedPublicationFactsType = Readonly<{
	readonly bindings: readonly ExtractedBindingType[];
	readonly bindingContexts: readonly ExtractedBindingContextType[];
	readonly bindingSites: readonly ExtractedBindingSiteType[];
	readonly surfaceOrigins: readonly ExtractedSurfaceOriginType[];
}>;

/**
 * Complete serializable fact bundle crossing the adapter seam.
 *
 * Compiler and parser objects never appear in this shape. The core finalizes
 * these facts and storage persists the resulting bindings, contexts, sites,
 * origins, occurrences, and aggregate statistics.
 */
export type ExtractedFactSetType = Readonly<{
	readonly files: readonly SourceFileType[];
	readonly symbols: readonly IndexedSymbolType[];
	readonly bindings: readonly ExtractedBindingType[];
	readonly bindingContexts: readonly ExtractedBindingContextType[];
	readonly bindingSites: readonly ExtractedBindingSiteType[];
	readonly surfaceOrigins: readonly ExtractedSurfaceOriginType[];
	readonly occurrences: readonly ExtractedOccurrenceType[];
	readonly dependencies: DependencyExtractionResultType;
	readonly adapterStats: readonly AdapterStatType[];
	readonly diagnostics: readonly DiagnosticType[];
	readonly compilerMs: number;
	readonly extractionMs: number;
}>;

/**
 * One serializable fact bundle crossing the adapter seam.
 *
 * The bundle carries files, symbols, occurrences, dependencies, diagnostics, and
 * the complete extracted publication facts. The core finalizer derives canonical
 * identities and exposure; storage persists the finalized set atomically.
 */
export type AdapterBuildType = ExtractedFactSetType &
	Readonly<{
		/**
		 * Re-verifies captured inputs immediately before publication.
		 *
		 * Adapters that captured an immutable input snapshot supply this so the
		 * core can reject a build whose inputs drifted during extraction.
		 */
		readonly validate?: () => void;
	}>;

/** One adapter-owned cache artifact written under a content hash. */
export type AdapterArtifactType = Readonly<{
	readonly contentSha256: string;
	readonly kind: string;
}>;

/** One adapter-owned cache artifact payload. */
export type AdapterArtifactEntryType = AdapterArtifactType & Readonly<{readonly payload: string}>;

/** Persisted artifact cache handed to an adapter for the duration of one build. */
export type AdapterArtifactCacheType = Readonly<{
	/** Reports whether the identical artifact is already persisted. */
	readonly has: (artifact: AdapterArtifactType) => boolean;
	/** Buffers one artifact payload for persistence after the build. */
	readonly write: (artifact: AdapterArtifactEntryType) => void;
}>;

/** Evidence available to an adapter that wants to reuse the published facts. */
export type AdapterFactReuseInputType = Readonly<{
	readonly config: AdapterConfigType;
	readonly scan: ScanResultType;
	/** Files and content hashes of the published generation. */
	readonly publishedFiles: readonly Readonly<{readonly path: string; readonly sha256: string}>[];
	/** Reads one persisted artifact under its content hash, or null when absent. */
	readonly read: (artifact: AdapterArtifactType) => string | null;
	/** Buffers an artifact that the proof itself produced, such as a new digest. */
	readonly write: (artifact: AdapterArtifactEntryType) => void;
}>;

/** Declared availability of one adapter before scanning. */
export type AdapterProbeResultType = Readonly<{available: true}> | Readonly<{available: false; reason: string}>;

/**
 * Language adapter contract.
 *
 * The core owns generations, storage, publication, freshness, limits, and
 * query/MCP orchestration. An adapter owns everything that needs a language
 * compiler: project loading, which files belong to the project, declarations,
 * occurrences, dependency facts, and diagnostics.
 *
 * Adapter results contain only serializable, language-neutral facts. Compiler
 * objects never cross this boundary. Methods may return a value or a Promise;
 * the host always awaits them.
 */
export type AdapterType = Readonly<{
	/** Stable adapter identifier persisted with every generation. */
	readonly id: string;
	/** Adapter implementation version; part of the build configuration hash. */
	readonly version: string;
	/** Human-readable adapter name for status and console output. */
	readonly displayName: string;
	/** Adapter-specific MCP discovery guidance. */
	readonly discoveryText: string;
	/**
	 * Closed, versioned absence reasons an optional adapter may report.
	 *
	 * Only declared reasons are persisted; core never interprets them.
	 */
	readonly absenceReasons?: readonly string[];
	/**
	 * Probes whether the adapter can run for this configuration.
	 *
	 * A required adapter is always built. An optional adapter may report declared
	 * unavailability before scanning, which is recorded as coverage.
	 */
	readonly probe?: (config: AdapterConfigType) => AdapterProbeResultType | Promise<AdapterProbeResultType>;
	/**
	 * Folds one authored query name to the adapter's canonical published spelling.
	 *
	 * Storage compares binding names verbatim, so an adapter whose canonical
	 * names differ from authored text must supply this to keep queries from
	 * missing declarations that are already indexed. Omit it when authored and
	 * published spellings are identical.
	 */
	readonly normalizeQueryName?: (text: string) => string;
	/** File extensions the adapter publishes; used by the watcher. */
	readonly sourceExtensions: readonly string[];
	/** Optional configuration-dependent extensions, such as manifest-defined Oracle source. */
	readonly sourceExtensionsFor?: (config: AdapterConfigType) => readonly string[];
	/** Directory segments excluded from watching and publication. */
	readonly ignoredSegments: readonly string[];
	/** Limitations reported by `index_status`. */
	readonly limitations: readonly string[];
	/**
	 * Computes the deterministic source manifest and fingerprints.
	 *
	 * @param config - Resolved adapter configuration.
	 * @param knownPaths - Files in the published generation, so imported files
	 * outside the project include stay in the freshness set.
	 */
	scan: (config: AdapterConfigType, knownPaths: readonly string[]) => ScanResultType | Promise<ScanResultType>;
	/** Extracts declarations, occurrences, dependencies, and diagnostics. */
	build: (config: AdapterConfigType, scan: ScanResultType, cache?: AdapterArtifactCacheType) => AdapterBuildType | Promise<AdapterBuildType>;
	/**
	 * Proves that the published facts remain valid for a changed source manifest.
	 *
	 * Returning true lets the core revise version metadata without extraction.
	 * The proof must be conservative: any doubt returns false.
	 */
	canReusePublishedFacts?: (input: AdapterFactReuseInputType) => boolean | Promise<boolean>;
	/** Absolute configuration files that affect extraction. */
	configFiles: (config: AdapterConfigType) => readonly string[];
	/** Reports whether a path is publishable authored source. */
	isSourceFile: (absolutePath: string, rootDir: string) => boolean;
}>;

/** Metadata exported by one adapter module. */
export type AdapterManifestType = Readonly<{
	readonly protocolVersion: number;
	readonly id: string;
	readonly implementationVersion: string;
	readonly displayName: string;
}>;

/** Named export shape implemented by every adapter module. */
export type AdapterModuleType = Readonly<{
	readonly manifest: AdapterManifestType;
	readonly create: () => AdapterType;
}>;
