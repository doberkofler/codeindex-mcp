import {type AdapterConfigType, type AdapterType} from '@codeindex/adapter-sdk';

export type {
	AdapterArtifactCacheType as ExtractorArtifactCacheType,
	AdapterBuildType as ExtractorBuildType,
	AdapterFactReuseInputType as ExtractorFactReuseInputType,
	AdapterType as ExtractorType,
} from '@codeindex/adapter-sdk';

/**
 * Resolves the source extensions an extractor publishes for one configuration.
 *
 * @param extractor - Selected extractor.
 * @param config - Resolved project configuration.
 * @returns Configured extensions, or the adapter's static fallback.
 */
export const extractorSourceExtensions = (extractor: AdapterType, config: AdapterConfigType): readonly string[] =>
	extractor.sourceExtensionsFor?.(config) ?? extractor.sourceExtensions;
