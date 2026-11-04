import type * as ts from './compiler.ts';

const SYNTHETIC_PRIVATE_NAME = /^__#\d+@(?<name>#.+)$/u;

/**
 * Authored name of one compiler symbol.
 *
 * TypeScript escapes `#private` member names as `__#<nodeId>@#name`. The node
 * id is compiler-internal and differs between program instances, so persisting
 * it would make symbol identity unstable across builds and hide the name from
 * search. Every stored name goes through this normalisation.
 *
 * @param symbol - Compiler symbol.
 * @returns The authored name, with the synthetic private-member prefix removed.
 */
export const symbolNameOf = (symbol: ts.Symbol): string => SYNTHETIC_PRIVATE_NAME.exec(symbol.name)?.groups?.['name'] ?? symbol.name;

/**
 * Reports whether one compiler symbol denotes a `#private` member.
 *
 * @param symbol - Compiler symbol.
 * @returns True when the authored name starts with `#`.
 */
export const isPrivateMemberSymbol = (symbol: ts.Symbol): boolean => symbolNameOf(symbol).startsWith('#');
