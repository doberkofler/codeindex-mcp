import * as ts from './compiler.ts';
import {isPrivateMemberSymbol} from './symbolName.ts';

/**
 * Symbol and type predicates used to decide what may be published.
 *
 * Each predicate resolves declarations and file names through the compiler
 * process, so the answers are cached: reachability asks the same questions about
 * the same symbols from many roots.
 */

/**
 * Returns the authored declarations of a symbol.
 *
 * @param symbol - Compiler symbol.
 * @param authoredPaths - Absolute authored file paths.
 * @returns Declarations that live in an authored file.
 */
export const authoredDeclarationsOf = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): readonly ts.Declaration[] =>
	ts.declarationsOf(symbol).filter((declaration) => authoredPaths.has(ts.declarationFileNameOf(declaration)));

/**
 * Cached externality verdict per symbol.
 *
 * The verdict depends only on the symbol's declarations and the authored path
 * set, both stable for the loaded program.
 */
const externalVerdicts = new WeakMap<ts.Symbol, Readonly<{paths: ReadonlySet<string>; external: boolean}>>();

/** Cached privacy verdict per symbol. */
const privateVerdicts = new WeakMap<ts.Symbol, boolean>();

export const isExternalSymbol = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): boolean => {
	const cached = externalVerdicts.get(symbol);

	if (cached?.paths === authoredPaths) {
		return cached.external;
	}

	const declarations = ts.declarationsOf(symbol);
	const external = declarations.length > 0 && declarations.every((declaration) => !authoredPaths.has(ts.declarationFileNameOf(declaration)));
	externalVerdicts.set(symbol, {paths: authoredPaths, external});
	return external;
};

export const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol => {
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return symbol;
	}

	try {
		return checker.getAliasedSymbol(symbol);
	} catch {
		return symbol;
	}
};

export const isExternalType = (type: ts.Type, authoredPaths: ReadonlySet<string>): boolean => {
	for (const candidate of [type.getAliasSymbol(), type.getSymbol()]) {
		if (candidate !== undefined && isExternalSymbol(candidate, authoredPaths)) {
			return true;
		}
	}

	return false;
};

const isAnonymousClassExpression = (symbol: ts.Symbol): boolean =>
	ts.declarationsOf(symbol).some((declaration) => ts.isClassExpression(declaration) && declaration.name === undefined);

export const namedSymbolOf = (type: ts.Type, authoredPaths: ReadonlySet<string>): ts.Symbol | null => {
	const namedFlags = [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum];

	for (const candidate of [type.getAliasSymbol(), type.getSymbol()]) {
		if (
			candidate !== undefined &&
			namedFlags.some((flag) => (candidate.flags & flag) !== 0) &&
			authoredDeclarationsOf(candidate, authoredPaths).length > 0 &&
			!isAnonymousClassExpression(candidate)
		) {
			return candidate;
		}
	}

	return null;
};

export const isAnonymousShape = (type: ts.Type, authoredPaths: ReadonlySet<string>): boolean =>
	(type.flags & ts.TypeFlags.Object) !== 0 && namedSymbolOf(type, authoredPaths) === null;

const isPrivateDeclaration = (declaration: ts.Declaration): boolean =>
	(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private) !== 0 ||
	(ts.canHaveModifiers(declaration) && (ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) ?? false));

export const isPrivateProperty = (property: ts.Symbol): boolean => {
	const cached = privateVerdicts.get(property);

	if (cached !== undefined) {
		return cached;
	}

	const isPrivate = isPrivateMemberSymbol(property) || ts.declarationsOf(property).some((declaration) => isPrivateDeclaration(declaration));
	privateVerdicts.set(property, isPrivate);
	return isPrivate;
};

export const isInheritedProperty = (property: ts.Symbol, rootDeclarations: readonly ts.Node[]): boolean => {
	const declarations = ts.declarationsOf(property);

	if (declarations.length === 0 || rootDeclarations.length === 0) {
		return false;
	}

	return declarations.every((declaration) => ts.findAncestor(declaration, (ancestor) => rootDeclarations.includes(ancestor)) === undefined);
};
