import * as ts from './compiler.ts';
import {type ExtractionRuntimeType} from './extractionRuntime.ts';

const MERGED_ALIAS_VALUE_FLAGS = [ts.SymbolFlags.Function, ts.SymbolFlags.Class, ts.SymbolFlags.BlockScopedVariable];

const safeImmediateAlias = function* safeImmediateAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.APIRequestGenerator<ts.Symbol | undefined> {
	try {
		return yield* checker.getImmediateAliasedSymbol.gen(symbol);
	} catch {
		return undefined;
	}
};

const safeAlias = function* safeAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.APIRequestGenerator<ts.Symbol | null> {
	try {
		return yield* checker.getAliasedSymbol.gen(symbol);
	} catch {
		return null;
	}
};

/**
 * Resolves occurrence aliases through the TypeScript request scheduler.
 *
 * @param runtime - Extraction state whose alias cache is populated.
 * @param symbols - Compiler symbols whose unresolved aliases should be cached.
 */
export const preloadAliasTargets = (runtime: ExtractionRuntimeType, symbols: Iterable<ts.Symbol | undefined>): void => {
	const aliases = [
		...new Set(
			[...symbols].filter(
				(symbol): symbol is ts.Symbol => symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !runtime.aliasTargets.has(symbol.id),
			),
		),
	];
	const simpleAliases = aliases.filter((symbol) => !MERGED_ALIAS_VALUE_FLAGS.some((flag) => (symbol.flags & flag) !== 0));
	const simpleAliasSet = new Set(simpleAliases);
	const immediate = runtime.input.project.batch(...simpleAliases.map((symbol) => safeImmediateAlias(runtime.checker, symbol)));
	const unresolved: ts.Symbol[] = aliases.filter((symbol) => !simpleAliasSet.has(symbol));

	for (const [index, symbol] of simpleAliases.entries()) {
		const candidate = immediate[index];
		const immediateId = candidate === undefined ? undefined : runtime.symbolIdByCanonical.get(candidate);

		if (immediateId === undefined) {
			unresolved.push(symbol);
		} else {
			runtime.aliasTargets.set(symbol.id, {target: symbol, immediateId});
		}
	}

	const targets = runtime.input.project.batch(...unresolved.map((symbol) => safeAlias(runtime.checker, symbol)));

	for (const [index, symbol] of unresolved.entries()) {
		const target = targets[index];
		runtime.aliasTargets.set(symbol.id, target === null || target === undefined ? null : {target, immediateId: null});
	}
};
