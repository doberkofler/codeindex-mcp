import ts from 'typescript';

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

export const resolveImmediateAliasSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined => {
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return undefined;
	}

	try {
		return checker.getImmediateAliasedSymbol(symbol);
	} catch {
		return undefined;
	}
};

export const resolveCanonical = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined => {
	const symbol = checker.getSymbolAtLocation(node);
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

	if (ts.isJsxAttribute(parent) && parent.name === node) {
		contextualType = checker.getContextualType(parent.parent);
	}

	return contextualType === undefined ? undefined : checker.getPropertyOfType(contextualType, node.text);
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
