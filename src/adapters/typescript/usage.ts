import ts from 'typescript';

const CALL = 1;
const READ = 2;
const WRITE = 4;
const READ_WRITE = 6;
const TYPE_REF = 8;

const TYPE_NODES: readonly ((node: ts.Node) => boolean)[] = [
	ts.isTypeReferenceNode,
	ts.isTypeQueryNode,
	ts.isTypeAliasDeclaration,
	ts.isInterfaceDeclaration,
	ts.isTypeLiteralNode,
	ts.isExpressionWithTypeArguments,
	ts.isHeritageClause,
	ts.isTypePredicateNode,
	ts.isMappedTypeNode,
	ts.isConditionalTypeNode,
	ts.isIndexedAccessTypeNode,
	ts.isInferTypeNode,
	ts.isImportTypeNode,
	ts.isTypeOperatorNode,
	ts.isParenthesizedTypeNode,
	ts.isArrayTypeNode,
	ts.isTupleTypeNode,
	ts.isUnionTypeNode,
	ts.isIntersectionTypeNode,
];

const isTypeNode = (node: ts.Node): boolean => {
	for (const predicate of TYPE_NODES) {
		if (predicate(node)) {
			return true;
		}
	}

	return false;
};

const isTypePosition = (node: ts.Node): boolean => {
	let current = node.parent;

	while (!ts.isSourceFile(current)) {
		if (isTypeNode(current)) {
			return true;
		}

		if (ts.isExpression(current) || ts.isStatement(current)) {
			return false;
		}

		current = current.parent;
	}

	return false;
};

const isInvocation = (node: ts.Node): boolean => ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node);

const invocationExpression = (node: ts.Node): ts.Node | null => {
	if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
		return node.expression;
	}

	return ts.isTaggedTemplateExpression(node) ? node.tag : null;
};

const isDirectCallee = (node: ts.Node): boolean => ts.isIdentifier(node) && invocationExpression(node.parent) === node;

const isAccessCallee = (node: ts.Node): boolean => {
	const {parent} = node;

	if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
		return isInvocation(parent.parent) && invocationExpression(parent.parent) === parent;
	}

	if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
		return isInvocation(parent.parent) && invocationExpression(parent.parent) === parent;
	}

	return false;
};

const expressionRoot = (node: ts.Node): ts.Node => {
	let current = node;

	while (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) {
		current = current.parent;
	}

	return current;
};

const assignmentUsage = (node: ts.Node): number => {
	const root = expressionRoot(node);
	const {parent} = root;

	if (ts.isBinaryExpression(parent) && parent.left === root) {
		return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? WRITE : READ_WRITE;
	}

	if (
		(ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
		(parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
	) {
		return READ_WRITE;
	}

	return 0;
};

/**
 * Classifies the syntactic usage of one compiler-resolved reference.
 *
 * @param node - Reference identifier.
 * @returns A legal usage bitmask: 0, 1, 2, 4, 6, or 8.
 */
export const usageOfReference = (node: ts.Identifier): number => {
	if (isTypePosition(node)) {
		return TYPE_REF;
	}

	if (isDirectCallee(node) || isAccessCallee(node)) {
		return CALL;
	}

	const assignment = assignmentUsage(node);

	return assignment === 0 ? READ : assignment;
};
