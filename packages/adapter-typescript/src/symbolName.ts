import * as ts from './compiler.ts';

const SYNTHETIC_PRIVATE_NAME = /^__#\d+@(?<name>#.+)$/u;
const SYNTHETIC_UNIQUE_SYMBOL_NAME = /^(?<name>__@.+)@\d+$/u;

const syntheticUniqueSymbolNameOf = (symbol: ts.Symbol): string | undefined => {
	const matched = SYNTHETIC_UNIQUE_SYMBOL_NAME.exec(symbol.name)?.groups?.['name'];
	return matched !== undefined && (symbol.checkFlags & ts.CheckFlags.Late) !== 0 ? matched : undefined;
};

/**
 * Authored name of one compiler symbol.
 *
 * TypeScript escapes `#private` member names as `__#<nodeId>@#name` and computed
 * unique-symbol members as `__@name@<symbolId>`. Both identifiers are
 * compiler-internal and differ between program instances, so persisting them
 * would make symbol identity unstable across builds. Every stored name goes
 * through this normalisation; quoted authored names that resemble the computed
 * form are preserved.
 *
 * @param symbol - Compiler symbol.
 * @returns The authored name without compiler-instance identifiers.
 */
export const symbolNameOf = (symbol: ts.Symbol): string =>
	SYNTHETIC_PRIVATE_NAME.exec(symbol.name)?.groups?.['name'] ?? syntheticUniqueSymbolNameOf(symbol) ?? symbol.name;

/**
 * Reports whether one compiler symbol denotes a `#private` member.
 *
 * @param symbol - Compiler symbol.
 * @returns True when the authored name starts with `#`.
 */
export const isPrivateMemberSymbol = (symbol: ts.Symbol): boolean => symbolNameOf(symbol).startsWith('#');
