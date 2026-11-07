import * as ts from './compiler.ts';
import {isObjectLiteralMember, isStoredDeclaration, nameNodeOf} from './publicationAddress.ts';

const isDirectExportNode = (node: ts.Node): boolean => {
	const {parent} = node;

	if (ts.isExportAssignment(parent)) {
		return !parent.isExportEquals && parent.expression === node && ts.isIdentifier(node);
	}

	return ts.isExportDeclaration(parent) && parent.moduleSpecifier === node && parent.exportClause === undefined;
};

const isPotentialNameNode = (node: ts.Node): boolean =>
	ts.isIdentifier(node) ||
	ts.isStringLiteral(node) ||
	ts.isNumericLiteral(node) ||
	ts.isComputedPropertyName(node) ||
	node.kind === ts.SyntaxKind.PrivateIdentifier;

/**
 * Reports whether candidate collection will query a node's symbol.
 *
 * Keeping this syntax-only plan beside the candidate collector prevents the
 * large-project resolver from falling back to one cross-process request per
 * declaration.
 *
 * @param node - Authored syntax node.
 * @returns Whether the node requires a direct compiler symbol lookup.
 */
export const isCandidateSymbolNode = (node: ts.Node): boolean => {
	if (isDirectExportNode(node)) {
		return true;
	}

	if (!isPotentialNameNode(node)) {
		return false;
	}

	const {parent} = node;

	if (isObjectLiteralMember(parent)) {
		return nameNodeOf(parent) === node;
	}

	return (isStoredDeclaration(parent) || ts.isExportSpecifier(parent) || ts.isNamespaceExport(parent)) && nameNodeOf(parent) === node;
};
