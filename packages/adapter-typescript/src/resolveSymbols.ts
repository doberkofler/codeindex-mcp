import * as ts from './compiler.ts';

const resolveAliasSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined => {
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return symbol;
	}

	try {
		return checker.getAliasedSymbol(symbol);
	} catch {
		return undefined;
	}
};

export const resolveCanonical = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined => {
	const symbol = checker.getSymbolAtLocation(node);
	return symbol === undefined ? undefined : resolveAliasSymbol(checker, symbol);
};

/**
 * Resolves one node to its canonical symbol using a shared symbol lookup.
 *
 * @param symbolAt - Batched identifier lookup with checker fallback.
 * @param checker - Program type checker.
 * @param node - Declaration or reference node.
 * @returns The aliased target symbol, when one can be resolved.
 */
export const resolveCanonicalFrom = (symbolAt: (node: ts.Node) => ts.Symbol | undefined, checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined => {
	const symbol = symbolAt(node);
	return symbol === undefined ? undefined : resolveAliasSymbol(checker, symbol);
};

const contextualPropertySymbol = (checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined => {
	const {parent} = node;
	let contextualType: ts.Type | undefined;

	if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) {
		const objectLiteral = parent.parent;

		if (ts.isObjectLiteralExpression(objectLiteral)) {
			contextualType = checker.getContextualType(objectLiteral);
		}
	}

	if (ts.isJsxAttribute(parent) && parent.name === node && ts.isJsxAttributes(parent.parent)) {
		contextualType = checker.getContextualType(parent.parent);
	}

	return contextualType === undefined ? undefined : checker.getPropertyOfType(contextualType, node.text);
};

/**
 * Reports whether an identifier needs contextual symbol resolution.
 *
 * Object-literal members and JSX attributes resolve to the declared member,
 * not to the declaration the identifier text points at. Every other identifier
 * is already resolved by the symbol at its location.
 *
 * @param node - Identifier occurrence.
 * @returns True when contextual resolution is required.
 */
export const needsOccurrenceResolution = (node: ts.Identifier): boolean => {
	const {parent} = node;

	if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
		return true;
	}

	if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node && ts.isObjectLiteralExpression(parent.parent)) {
		return true;
	}

	return ts.isJsxAttribute(parent) && parent.name === node;
};

/**
 * Resolves an identifier occurrence to the symbol reported by TypeScript.
 *
 * @param checker - Program type checker.
 * @param node - Identifier occurrence.
 * @returns The canonical symbol, when one can be resolved.
 */
export const resolveOccurrenceSymbol = (checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined => {
	const {parent} = node;

	if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
		const valueSymbol = checker.getShorthandAssignmentValueSymbol(parent);
		return valueSymbol === undefined ? undefined : resolveAliasSymbol(checker, valueSymbol);
	}

	const contextual = contextualPropertySymbol(checker, node);

	if (contextual !== undefined) {
		return resolveAliasSymbol(checker, contextual);
	}

	return resolveCanonical(checker, node);
};
