import {CodeIndexError} from './codeIndexError.ts';

export {CodeIndexError} from './codeIndexError.ts';
export {type ErrorCodeType} from './errorCode.ts';
export {IndexNotReadyError} from './indexNotReadyError.ts';
export {StaleFileError} from './staleFileError.ts';

/**
 * Narrows an unknown thrown value to an index error.
 *
 * @param error - Value caught from a tool or build operation.
 * @returns Whether the value is a {@link CodeIndexError}.
 */
export const isCodeIndexError = (error: unknown): error is CodeIndexError => error instanceof CodeIndexError;
