import * as ts from './compiler.ts';
import {type IdentifierSymbolsType} from './identifierSymbols.ts';

const resolveAlias = function* resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.APIRequestGenerator<ts.Symbol | undefined> {
	if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return symbol;
	}

	try {
		return yield* checker.getAliasedSymbol.gen(symbol);
	} catch {
		return undefined;
	}
};

const contextualPropertySymbol = function* contextualPropertySymbol(
	checker: ts.TypeChecker,
	node: ts.Identifier,
): ts.APIRequestGenerator<ts.Symbol | undefined> {
	const {parent} = node;
	let contextualType: ts.Type | undefined;

	if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) {
		const objectLiteral = parent.parent;

		if (ts.isObjectLiteralExpression(objectLiteral)) {
			contextualType = yield* checker.getContextualType.gen(objectLiteral);
		}
	}

	if (ts.isJsxAttribute(parent) && parent.name === node && ts.isJsxAttributes(parent.parent)) {
		contextualType = yield* checker.getContextualType.gen(parent.parent);
	}

	return contextualType === undefined ? undefined : yield* checker.getPropertyOfType.gen(contextualType, node.text);
};

const resolveOccurrenceSymbol = function* resolveOccurrenceSymbol(
	checker: ts.TypeChecker,
	node: ts.Identifier,
	raw: ts.Symbol | undefined,
): ts.APIRequestGenerator<ts.Symbol | undefined> {
	const {parent} = node;

	if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
		return yield* resolveAlias(checker, yield* checker.getShorthandAssignmentValueSymbol.gen(parent));
	}

	const contextual = yield* contextualPropertySymbol(checker, node);
	return yield* resolveAlias(checker, contextual ?? raw);
};

/**
 * Resolves one bounded identifier group in shared compiler dependency rounds.
 *
 * Callers consume and release each returned map before scheduling the next
 * group, so large programs do not retain every compiler `Symbol` wrapper.
 *
 * @param batch - Scheduler for the compiler generators.
 * @param checker - Type checker for the loaded program.
 * @param identifierSymbols - Bulk-resolved direct identifier symbols.
 * @param identifiers - Bounded contextual identifier group.
 * @returns Contextual identifiers mapped to their canonical symbols.
 */
export const resolveOccurrenceSymbols = (
	batch: ts.API['batch'],
	checker: ts.TypeChecker,
	identifierSymbols: IdentifierSymbolsType,
	identifiers: readonly ts.Identifier[],
): ReadonlyMap<ts.Identifier, ts.Symbol | undefined> => {
	const symbols = new Map<ts.Identifier, ts.Symbol | undefined>();
	const resolved = batch(...identifiers.map((node) => resolveOccurrenceSymbol(checker, node, identifierSymbols.get(node))));

	for (const [index, node] of identifiers.entries()) {
		symbols.set(node, resolved[index]);
	}

	return symbols;
};
