import {type ConfigType} from '../core/config/config.ts';
import {type ExtractedFactSetType} from '../core/facts/index.ts';
import {type ScanResultType} from '../core/model.ts';

/**
 * One serializable fact bundle crossing the adapter seam.
 *
 * The bundle carries files, symbols, occurrences, dependencies, diagnostics, and
 * the complete extracted publication facts. The core finalizer derives canonical
 * identities and exposure; storage persists the finalized set atomically.
 */
export type ExtractorBuildType = ExtractedFactSetType;

/**
 * Language adapter contract.
 *
 * The core owns generations, storage, publication, freshness, limits, and
 * query/MCP orchestration. An adapter owns everything that needs a language
 * compiler: project loading, which files belong to the project, declarations,
 * occurrences, dependency facts, and diagnostics.
 *
 * Adapter results contain only serializable, language-neutral facts. Compiler
 * objects never cross this boundary.
 */
/**
 * Resolves the source extensions an extractor publishes for one configuration.
 *
 * @param extractor - Selected extractor.
 * @param config - Resolved project configuration.
 * @returns Configured extensions, or the adapter's static fallback.
 */
export const extractorSourceExtensions = (extractor: ExtractorType, config: ConfigType): readonly string[] =>
	extractor.sourceExtensionsFor?.(config) ?? extractor.sourceExtensions;

/**
 * One adapter-owned cache artifact written under a content hash.
 *
 * Artifacts are derived data: losing them costs work, never correctness.
 */
type ExtractorArtifactType = Readonly<{
	readonly contentSha256: string;
	readonly kind: string;
}>;

/** One adapter-owned cache artifact payload. */
type ExtractorArtifactEntryType = ExtractorArtifactType & Readonly<{readonly payload: string}>;

/** Persisted artifact cache handed to an extractor for the duration of one build. */
export type ExtractorArtifactCacheType = Readonly<{
	/** Reports whether the identical artifact is already persisted. */
	readonly has: (artifact: ExtractorArtifactType) => boolean;
	/** Buffers one artifact payload for persistence after the build. */
	readonly write: (artifact: ExtractorArtifactEntryType) => void;
}>;

/** Evidence available to an extractor that wants to reuse the published facts. */
export type ExtractorFactReuseInputType = Readonly<{
	readonly config: ConfigType;
	readonly scan: ScanResultType;
	/** Files and content hashes of the published generation. */
	readonly publishedFiles: readonly Readonly<{readonly path: string; readonly sha256: string}>[];
	/** Reads one persisted artifact under its content hash, or null when absent. */
	readonly read: (artifact: ExtractorArtifactType) => string | null;
	/** Buffers an artifact that the proof itself produced, such as a new digest. */
	readonly write: (artifact: ExtractorArtifactEntryType) => void;
}>;

export type ExtractorType = Readonly<{
	/** Stable adapter identifier persisted with every generation. */
	readonly id: string;
	/** Adapter implementation version; part of the build configuration hash. */
	readonly version: string;
	/** Human-readable adapter name for status and console output. */
	readonly displayName: string;
	/** Adapter-specific MCP discovery guidance. */
	readonly discoveryText: string;
	/** File extensions the adapter publishes; used by the watcher. */
	readonly sourceExtensions: readonly string[];
	/** Optional configuration-dependent extensions, such as manifest-defined Oracle source. */
	readonly sourceExtensionsFor?: (config: ConfigType) => readonly string[];
	/** Directory segments excluded from watching and publication. */
	readonly ignoredSegments: readonly string[];
	/** Limitations reported by `index_status`. */
	readonly limitations: readonly string[];
	/**
	 * Computes the deterministic source manifest and fingerprints.
	 *
	 * @param config - Resolved project configuration.
	 * @param knownPaths - Files in the published generation, so imported files
	 * outside the project include stay in the freshness set.
	 */
	scan: (config: ConfigType, knownPaths: readonly string[]) => ScanResultType;
	/** Extracts declarations, occurrences, dependencies, and diagnostics. */
	build: (config: ConfigType, scan: ScanResultType, cache?: ExtractorArtifactCacheType) => ExtractorBuildType;
	/**
	 * Proves that the published facts remain valid for a changed source manifest.
	 *
	 * Returning true lets the core revise version metadata without extraction.
	 * The proof must be conservative: any doubt returns false.
	 */
	canReusePublishedFacts?: (input: ExtractorFactReuseInputType) => boolean;
	/** Absolute configuration files that affect extraction. */
	configFiles: (config: ConfigType) => readonly string[];
	/** Reports whether a path is publishable authored source. */
	isSourceFile: (absolutePath: string, rootDir: string) => boolean;
}>;
