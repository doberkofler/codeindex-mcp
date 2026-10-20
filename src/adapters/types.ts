import {type ConfigType} from '../core/config/config.ts';
import {type ExtractedFactSetType} from '../core/facts/index.ts';
import {type ScanResultType} from '../core/model.ts';

/**
 * One serializable fact bundle crossing the adapter seam.
 *
 * The existing persistence path consumes the legacy symbol, occurrence,
 * dependency, and diagnostic fields. Publication bindings, contexts, sites, and
 * origins remain report-only until the schema redesign is accepted.
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

export type ExtractorType = Readonly<{
	/** Stable adapter identifier persisted with every generation. */
	readonly id: string;
	/** Adapter implementation version; part of the build configuration hash. */
	readonly version: string;
	/** Human-readable adapter name for status and console output. */
	readonly displayName: string;
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
	build: (config: ConfigType, scan: ScanResultType) => ExtractorBuildType;
	/** Absolute configuration files that affect extraction. */
	configFiles: (config: ConfigType) => readonly string[];
	/** Reports whether a path is publishable authored source. */
	isSourceFile: (absolutePath: string, rootDir: string) => boolean;
}>;
