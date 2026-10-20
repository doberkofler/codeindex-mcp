import ts from 'typescript';

const hasExportModifier = (node: ts.Node): boolean => {
	const declaration =
		ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node;

	if (!ts.canHaveModifiers(declaration)) {
		return false;
	}

	return ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
};

const isTopLevelDeclaration = (node: ts.Node): boolean => {
	if (ts.isVariableDeclaration(node)) {
		const statement = node.parent.parent;

		return ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
	}

	return ts.isSourceFile(node.parent);
};

/**
 * Reports whether one preliminary lexical binding is a publication root.
 *
 * Phase 1 intentionally recognizes explicit export modifiers, external alias
 * clauses, and top-level script declarations only. Re-export expansion and
 * surface projection remain Phase 4 work.
 *
 * @param node - Candidate declaration node.
 * @param scope - Module or script scope of the containing file.
 * @returns True when the candidate is a preliminary publication root.
 */
export const isPublishedCandidate = (node: ts.Node, scope: 'module' | 'global'): boolean =>
	ts.isExportSpecifier(node) || hasExportModifier(node) || (scope === 'global' && isTopLevelDeclaration(node));
