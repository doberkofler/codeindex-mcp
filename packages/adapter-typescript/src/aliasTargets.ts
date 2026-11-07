import * as ts from './compiler.ts';
import {type ExtractionRuntimeType} from './extractionRuntime.ts';

const MERGED_ALIAS_VALUE_FLAGS = [ts.SymbolFlags.Function, ts.SymbolFlags.Class, ts.SymbolFlags.BlockScopedVariable];
const ALIASES_PER_BATCH = 10_000;

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
 * Resolves candidate aliases before candidate collection starts.
 *
 * @param batch - TypeScript request scheduler.
 * @param checker - Program type checker.
 * @param symbols - Direct candidate symbols.
 * @returns Canonical targets keyed by direct alias symbol identifier.
 */
export const resolveCandidateAliasTargets = (
	batch: ts.API['batch'],
	checker: ts.TypeChecker,
	symbols: Iterable<ts.Symbol | undefined>,
): ReadonlyMap<number, ts.Symbol | null> => {
	const aliases = [
		...new Map(
			[...symbols]
				.filter((symbol): symbol is ts.Symbol => symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
				.map((symbol) => [symbol.id, symbol]),
		).values(),
	];
	const targets = new Map<number, ts.Symbol | null>();

	for (let offset = 0; offset < aliases.length; offset += ALIASES_PER_BATCH) {
		const group = aliases.slice(offset, offset + ALIASES_PER_BATCH);
		const resolved = batch(...group.map((symbol) => safeAlias(checker, symbol)));

		for (const [index, symbol] of group.entries()) {
			targets.set(symbol.id, resolved[index] ?? null);
		}
	}

	return targets;
};

/**
 * Resolves occurrence aliases through the TypeScript request scheduler.
 *
 * @param runtime - Extraction state whose alias cache is populated.
 * @param symbols - Compiler symbols whose unresolved aliases should be cached.
 * @param canonicalTargets - Canonical targets already resolved for candidate collection.
 */
export const preloadAliasTargets = (
	runtime: ExtractionRuntimeType,
	symbols: Iterable<ts.Symbol | undefined>,
	canonicalTargets: ReadonlyMap<number, ts.Symbol | null> = new Map(),
): void => {
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

	const unresolvedWithoutTarget = unresolved.filter((symbol) => !canonicalTargets.has(symbol.id));
	const targets = runtime.input.project.batch(...unresolvedWithoutTarget.map((symbol) => safeAlias(runtime.checker, symbol)));

	for (const symbol of unresolved) {
		if (!canonicalTargets.has(symbol.id)) {
			continue;
		}

		const target = canonicalTargets.get(symbol.id);
		runtime.aliasTargets.set(symbol.id, target === null || target === undefined ? null : {target, immediateId: null});
	}

	for (const [index, symbol] of unresolvedWithoutTarget.entries()) {
		const target = targets[index];
		runtime.aliasTargets.set(symbol.id, target === null || target === undefined ? null : {target, immediateId: null});
	}
};
