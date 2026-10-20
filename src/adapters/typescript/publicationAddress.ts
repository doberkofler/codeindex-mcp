import ts from 'typescript';
import {type FactRangeType} from '../../core/facts/index.ts';
import {declarationKindOf, definitionMetadataOf} from './occurrenceMetadata.ts';
import {type CandidateDefinitionType, type CandidateInputType, type CandidateScopeType} from './publicationCandidateTypes.ts';

const rangeOf = (sourceFile: ts.SourceFile, start: number, end: number): FactRangeType => {
	const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
	const endPosition = sourceFile.getLineAndCharacterOfPosition(end);

	return {
		startLine: startPosition.line + 1,
		startColumn: startPosition.character + 1,
		endLine: endPosition.line + 1,
		endColumn: endPosition.character + 1,
		startOffset: start,
		endOffset: end,
	};
};

const nodeRange = (sourceFile: ts.SourceFile, node: ts.Node): FactRangeType => rangeOf(sourceFile, node.getStart(sourceFile), node.end);

const tokenNode = (sourceFile: ts.SourceFile, node: ts.Node, kinds: readonly ts.SyntaxKind[]): ts.Node | null => {
	for (const child of node.getChildren(sourceFile)) {
		if (kinds.includes(child.kind)) {
			return child;
		}
	}

	return null;
};

export const defaultTokenOf = (sourceFile: ts.SourceFile, node: ts.Node): ts.Node | null => {
	const modifier = ts.canHaveModifiers(node) ? ts.getModifiers(node)?.find((entry) => entry.kind === ts.SyntaxKind.DefaultKeyword) : undefined;

	if (modifier !== undefined) {
		return modifier;
	}

	const direct = tokenNode(sourceFile, node, [ts.SyntaxKind.DefaultKeyword]);

	if (direct !== null) {
		return direct;
	}

	for (const child of node.getChildren(sourceFile)) {
		const nested = tokenNode(sourceFile, child, [ts.SyntaxKind.DefaultKeyword]);

		if (nested !== null) {
			return nested;
		}
	}

	return null;
};

export const authoredOf = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): readonly ts.Declaration[] =>
	(symbol.declarations ?? []).filter((declaration) => authoredPaths.has(declaration.getSourceFile().fileName));

const enclosingScope = (node: ts.Node): CandidateScopeType | null => {
	if (ts.isSourceFile(node)) {
		return null;
	}

	const {parent} = node;

	if (ts.isSourceFile(parent)) {
		return null;
	}

	if (ts.isModuleDeclaration(parent)) {
		if (ts.isStringLiteral(parent.name)) {
			return {kind: 'external_module', target: parent.name.text};
		}

		if (parent.name.text === 'global' && (ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Ambient) !== 0) {
			return {kind: 'global'};
		}
	}

	return enclosingScope(parent);
};

export const scopeOfNode = (node: ts.Node, sourceFile: ts.SourceFile, pathByAbsolute: ReadonlyMap<string, string>): CandidateScopeType => {
	const enclosing = enclosingScope(node);

	if (enclosing !== null) {
		return enclosing;
	}

	const path = pathByAbsolute.get(sourceFile.fileName);

	return ts.isExternalModule(sourceFile) && path !== undefined ? {kind: 'module', path} : {kind: 'global'};
};

const isTopLevelVariable = (node: ts.Node): boolean => {
	const list = ts.findAncestor(node, ts.isVariableDeclarationList);

	if (list === undefined) {
		return false;
	}

	const statement = list.parent;

	return ts.isVariableStatement(statement) && (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent));
};

export const isObjectLiteralMember = (node: ts.Node): boolean => {
	const {parent} = node;

	return (
		ts.isObjectLiteralExpression(parent) &&
		(ts.isPropertyAssignment(node) ||
			ts.isShorthandPropertyAssignment(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node))
	);
};

const STORED_PREDICATES: readonly ((node: ts.Node) => boolean)[] = [
	ts.isInterfaceDeclaration,
	ts.isTypeAliasDeclaration,
	ts.isEnumDeclaration,
	ts.isEnumMember,
	ts.isMethodDeclaration,
	ts.isMethodSignature,
	ts.isPropertyDeclaration,
	ts.isPropertySignature,
	ts.isGetAccessorDeclaration,
	ts.isSetAccessorDeclaration,
];

export const isStoredDeclaration = (node: ts.Node): boolean => {
	if (ts.isParameter(node)) {
		if (!ts.isConstructorDeclaration(node.parent)) {
			return false;
		}

		const modifiers = ts.getModifiers(node) ?? [];

		return (
			!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) &&
			modifiers.some(
				(modifier) =>
					modifier.kind === ts.SyntaxKind.PublicKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword || modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
			)
		);
	}

	if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		return node.name !== undefined;
	}

	if (ts.isModuleDeclaration(node)) {
		return ts.isIdentifier(node.name);
	}

	if (STORED_PREDICATES.some((predicate) => predicate(node))) {
		return true;
	}

	if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
		return isTopLevelVariable(node);
	}

	return false;
};

const isNode = (value: unknown): value is ts.Node => typeof value === 'object' && value !== null && 'kind' in value && typeof value['kind'] === 'number';

export const nameNodeOf = (node: ts.Node): ts.Node | undefined => {
	if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
		const {name} = node;

		if (ts.isComputedPropertyName(name)) {
			return name;
		}

		return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name : undefined;
	}

	if (ts.isExportSpecifier(node) || ts.isNamespaceExport(node)) {
		return node.name;
	}

	if (!('name' in node)) {
		return undefined;
	}

	const {name} = node;

	return isNode(name) ? name : undefined;
};

const importTargetOf = (node: ts.ImportDeclaration, importedName: string): string | null => {
	const clause = node.importClause;

	if (clause === undefined || !ts.isStringLiteral(node.moduleSpecifier)) {
		return null;
	}

	if (clause.name?.text === importedName) {
		return node.moduleSpecifier.text;
	}

	const named = clause.namedBindings;

	for (const element of named !== undefined && ts.isNamedImports(named) ? named.elements : []) {
		if ((element.propertyName ?? element.name).text === importedName) {
			return node.moduleSpecifier.text;
		}
	}

	return named !== undefined && ts.isNamespaceImport(named) && named.name.text === importedName ? node.moduleSpecifier.text : null;
};

const externalTargetOf = (target: ts.Symbol, sourceFile: ts.SourceFile, localName?: string): string | null => {
	for (const declaration of target.declarations ?? []) {
		if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
			const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);

			if (importDeclaration !== undefined && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
				return importDeclaration.moduleSpecifier.text;
			}
		}
	}

	const importedName = localName ?? target.getName();
	let found: string | null = null;
	const visit = (node: ts.Node): void => {
		if (found !== null) {
			return;
		}

		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			found = importTargetOf(node, importedName) ?? found;
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return found;
};

const exportAssignmentLocalName = (node: ts.Node): string | undefined =>
	ts.isExportAssignment(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;

export const externalAliasOf = (node: ts.Node, target: ts.Symbol, sourceFile: ts.SourceFile): Readonly<{target: string; name: string}> | null => {
	let moduleTarget: string | null = null;
	let externalName = target.getName();

	if (ts.isExportSpecifier(node)) {
		const declaration = node.parent.parent;

		if (ts.isExportDeclaration(declaration) && declaration.moduleSpecifier !== undefined && ts.isStringLiteral(declaration.moduleSpecifier)) {
			moduleTarget = declaration.moduleSpecifier.text;
		}

		externalName = node.propertyName?.text ?? node.name.text;
	} else if (ts.isNamespaceExport(node)) {
		const declaration = node.parent;

		if (ts.isExportDeclaration(declaration) && declaration.moduleSpecifier !== undefined && ts.isStringLiteral(declaration.moduleSpecifier)) {
			moduleTarget = declaration.moduleSpecifier.text;
		}

		externalName = '*';
	} else if (ts.isExportAssignment(node)) {
		externalName = 'default';
	}

	moduleTarget ??= externalTargetOf(target, sourceFile, exportAssignmentLocalName(node));

	return moduleTarget === null ? null : {target: moduleTarget, name: externalName};
};

export const definitionOf = (input: CandidateInputType, declaration: ts.Node, nameNode: ts.Node): CandidateDefinitionType => {
	const sourceFile = declaration.getSourceFile();
	const metadata = definitionMetadataOf(sourceFile, declaration);
	const extent = metadata.extent ?? nodeRange(sourceFile, declaration);

	return {
		declaration,
		nameNode,
		kind: declarationKindOf(declaration),
		path: input.pathByAbsolute.get(sourceFile.fileName) ?? '',
		sourceFile,
		range: nodeRange(sourceFile, nameNode),
		extent,
		forwardDefinition: metadata.forwardDefinition ?? false,
		primaryRank: metadata.primaryRank ?? 0,
		anchorRank: metadata.anchorRank ?? 0,
	};
};
