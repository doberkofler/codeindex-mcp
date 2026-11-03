import {computeSourceHash as computeSourceHashOf, hashContent as hashContentOf} from '@codeindex/adapter-sdk';

export {createSourceFileRecord, createVerifiedSourceFileRecord} from '@codeindex/adapter-sdk';

/**
 * Hashes one source manifest.
 *
 * @param files - Source records.
 * @returns Lower-case hexadecimal SHA-256 digest.
 */
export const computeSourceHash = (files: Parameters<typeof computeSourceHashOf>[0]): string => computeSourceHashOf(files);

/**
 * Hashes one source text.
 *
 * Kept as a declared host symbol so impact analysis can name it directly.
 *
 * @param content - Source text.
 * @returns Lower-case hexadecimal SHA-256 digest.
 */
export const hashContent = (content: string): string => hashContentOf(content);
