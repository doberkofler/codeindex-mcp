declare const PROGRAM_VERSION_AT_BUILD: string;

export const PROGRAM_NAME = 'codeindex-mcp';

/**
 * Program version injected from the root package manifest at build and test time.
 *
 * Vite and Vitest replace the identifier, keeping `package.json` the sole version
 * source instead of duplicating a literal that can drift during release.
 */
export const PROGRAM_VERSION = PROGRAM_VERSION_AT_BUILD;
