import packageManifest from '../../package.json' with {type: 'json'};

declare const PROGRAM_VERSION_AT_BUILD: string | undefined;

export const PROGRAM_NAME = 'codeindex-mcp';

/**
 * Program version injected from the root package manifest at build and test time.
 *
 * Vite and Vitest replace the identifier, keeping `package.json` the sole version
 * source instead of duplicating a literal that can drift during release. Source
 * execution without a bundler, such as the maintainer qualification CLI, reads
 * the same manifest directly.
 */
export const PROGRAM_VERSION = typeof PROGRAM_VERSION_AT_BUILD === 'undefined' ? packageManifest.version : PROGRAM_VERSION_AT_BUILD;
