/**
 * Compiler surface used by the TypeScript adapter.
 *
 * The adapter is written against the TypeScript 7 synchronous API. Syntax
 * trees and node guards come from `typescript/ast`; symbols, types, programs,
 * and the checker come from `typescript/sync`. This module re-exports those
 * surfaces and provides the small AST utilities that the 7.x API no longer
 * publishes.
 *
 * @public
 */

import {type Declaration, type ModifierLike, type Node, type SourceFile, type StringLiteralLikeNode, SyntaxKind} from 'typescript/ast';
import {rootedDirectoryPathFromPath, rootedPathFromNormalized, type RootedDirectoryPath} from 'typescript/path';
import {type Diagnostic, type Program, type ReferencedSymbolEntry, type Symbol as CompilerSymbol} from 'typescript/sync';

// TypeScript 7 renamed several guards without changing their meaning. The
// adapter keeps the 6.x spellings so its call sites read the same as before.
export {
	isArrayTypeNode,
	isBinaryExpression,
	isBindingElement,
	isCallExpression,
	isClassDeclaration,
	isClassExpression,
	isComputedPropertyName,
	isConditionalTypeNode,
	isConstructorDeclaration,
	isElementAccessExpression,
	isEnumDeclaration,
	isEnumMember,
	isExportAssignment,
	isExportDeclaration,
	isExportSpecifier,
	isExpressionWithTypeArguments,
	isExternalModuleReference,
	isFunctionDeclaration,
	isGetAccessorDeclaration,
	isHeritageClause,
	isIdentifier,
	isImportClause,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isImportSpecifier,
	isImportTypeNode,
	isIndexedAccessTypeNode,
	isInferTypeNode,
	isInterfaceDeclaration,
	isIntersectionTypeNode,
	isJsxAttribute,
	isJsxAttributes,
	isJsxClosingElement,
	isJsxOpeningElement,
	isJsxSelfClosingElement,
	isLiteralTypeNode,
	isMappedTypeNode,
	isMethodDeclaration,
	isMethodSignatureDeclaration as isMethodSignature,
	isModuleBlock,
	isModuleDeclaration,
	isNamedExports,
	isNamedImports,
	isNamespaceExport,
	isNamespaceImport,
	isNewExpression,
	isNumericLiteral,
	isObjectBindingPattern,
	isObjectLiteralExpression,
	isParameterDeclaration as isParameter,
	isParenthesizedExpression,
	isParenthesizedTypeNode,
	isPostfixUnaryExpression,
	isPrefixUnaryExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isPropertyDeclaration,
	isPropertySignatureDeclaration as isPropertySignature,
	isSourceFile,
	isQualifiedName,
	isSetAccessorDeclaration,
	isShorthandPropertyAssignment,
	isStringLiteral,
	isStringLiteralLikeNode as isStringLiteralLike,
	isTaggedTemplateExpression,
	isTupleTypeNode,
	isTypeAliasDeclaration,
	isTypeLiteralNode,
	isTypeOperatorNode,
	isTypePredicateNode,
	isTypeQueryNode,
	isTypeReferenceNode,
	isUnionTypeNode,
	isVariableDeclaration,
	isVariableDeclarationList,
	isVariableStatement,
} from 'typescript/ast/is';
export {
	getCombinedModifierFlags,
	getNameOfDeclaration,
	isExpression,
	isExternalModule,
	isStatement,
	isTypeNode,
	ModifierFlags,
	NodeFlags,
	ScriptKind,
	SyntaxKind,
	TokenFlags,
} from 'typescript/ast';
export type {
	ArrayBindingPattern,
	ArrayLiteralExpression,
	ArrayTypeNode,
	ArrowFunction,
	BindingElement,
	BindingName,
	CallExpression,
	ClassDeclaration,
	ClassExpression,
	ComputedPropertyName,
	ConditionalTypeNode,
	ConstructorDeclaration,
	Declaration,
	ElementAccessExpression,
	EntityName,
	EnumDeclaration,
	EnumMember,
	ExportAssignment,
	ExportDeclaration,
	ExportSpecifier,
	Expression,
	ExpressionWithTypeArguments,
	ExternalModuleReference,
	FunctionDeclaration,
	GetAccessorDeclaration,
	HeritageClause,
	Identifier,
	ImportClause,
	ImportDeclaration,
	ImportEqualsDeclaration,
	ImportSpecifier,
	ImportTypeNode,
	IndexedAccessTypeNode,
	InferTypeNode,
	InterfaceDeclaration,
	IntersectionTypeNode,
	JsxAttribute,
	JsxClosingElement,
	JsxOpeningElement,
	JsxSelfClosingElement,
	LiteralTypeNode,
	MappedTypeNode,
	MethodDeclaration,
	MethodSignatureDeclaration,
	ModifierLike,
	ModuleBlock,
	ModuleDeclaration,
	ModuleExportName,
	NamedExports,
	NamedImports,
	NamespaceExport,
	NamespaceImport,
	Node,
	NodeArray,
	NoSubstitutionTemplateLiteral,
	NumericLiteral,
	ObjectBindingPattern,
	ObjectLiteralExpression,
	ParameterDeclaration,
	ParenthesizedExpression,
	ParenthesizedTypeNode,
	PostfixUnaryExpression,
	PrefixUnaryExpression,
	PropertyAccessExpression,
	PropertyAssignment,
	PropertyDeclaration,
	PropertySignatureDeclaration,
	QualifiedName,
	ScriptTarget,
	SetAccessorDeclaration,
	ShorthandPropertyAssignment,
	SourceFile,
	Statement,
	StringLiteral,
	StringLiteralLikeNode,
	TaggedTemplateExpression,
	Token,
	TupleTypeNode,
	TypeAliasDeclaration,
	TypeLiteralNode,
	TypeNode,
	TypeOperatorNode,
	TypePredicateNode,
	TypeQueryNode,
	TypeReferenceNode,
	UnionTypeNode,
	VariableDeclaration,
	VariableDeclarationList,
	VariableStatement,
} from 'typescript/ast';
export type {
	BigIntLiteralType,
	BooleanLiteralType,
	Checker as TypeChecker,
	CompilerOptions,
	ConditionalType,
	Diagnostic,
	GenericType,
	IndexedAccessType,
	IndexInfo,
	IndexType,
	InterfaceType,
	IntersectionType,
	IntrinsicType,
	LanguageService,
	MappedType,
	ModuleResolver,
	NumberLiteralType,
	ObjectType,
	ParsedCommandLine,
	Program,
	Project,
	ReferencedSymbolEntry,
	ResolutionMode,
	Signature,
	StringLiteralType,
	StringMappingType,
	SubstitutionType,
	Symbol,
	TemplateLiteralType,
	TupleType,
	TupleTypeReference,
	Type,
	TypeParameter,
	TypeReference,
	UnionOrIntersectionType,
	UnionType,
} from 'typescript/sync';
export {API, DiagnosticCategory, ModuleKind, ObjectFlags, SignatureKind, SymbolFlags, TypeFlags} from 'typescript/sync';
export {rootedDirectoryPathFromPath, rootedPathFromNormalized, toRootedDirectoryPath, toRootedFilePath, toRootedPath} from 'typescript/path';

/**
 * Brands an already rooted, normalized directory path.
 *
 * @param directory - Absolute normalized directory path.
 * @returns The same path with directory intent.
 */
export const rootedDirectory = (directory: string): RootedDirectoryPath => rootedDirectoryPathFromPath(rootedPathFromNormalized(directory));

/**
 * The numeric value of `DiagnosticCategory.Error`.
 *
 * Diagnostics from the protocol carry a plain number, so comparisons stay in
 * the numeric domain instead of mixing an enum with a widened field.
 */
export const ERROR_DIAGNOSTIC_CATEGORY = 1;

/** A string literal or a no-substitution template literal. */
export type StringLiteralLike = StringLiteralLikeNode;

/** A referenced symbol group returned by a language-service reference query. */
export type ReferencedSymbol = ReferencedSymbolEntry;

/**
 * Iterates the direct children of one node.
 *
 * @param node - Parent node.
 * @param visitor - Called once per direct child.
 */
export const forEachChild = (node: Node, visitor: (child: Node) => void): void => {
	node.forEachChild(visitor);
};

type ModifierCarrier = Node & {readonly modifiers?: readonly ModifierLike[] | undefined};

const carriesModifiers = (node: Node): node is ModifierCarrier => 'modifiers' in node;

/**
 * Reports whether a node can carry modifiers.
 *
 * @param node - Candidate node.
 * @returns True when modifiers may be present.
 */
export const canHaveModifiers = (node: Node): boolean => carriesModifiers(node);

/**
 * Returns the modifiers of a node, if it can carry them.
 *
 * @param node - Candidate node.
 * @returns Modifiers in source order, or undefined.
 */
export const getModifiers = (node: Node): readonly ModifierLike[] | undefined => (carriesModifiers(node) ? node.modifiers : undefined);

export function findAncestor<T extends Node>(node: Node, predicate: (candidate: Node) => candidate is T): T | undefined;
export function findAncestor(node: Node, predicate: (candidate: Node) => boolean): Node | undefined;
/**
 * Finds the closest ancestor that satisfies a predicate.
 *
 * @param node - Starting node.
 * @param predicate - Ancestor test.
 * @returns The closest matching ancestor, or undefined.
 */
export function findAncestor(node: Node, predicate: (candidate: Node) => boolean): Node | undefined {
	let current: Node = node.parent;

	while (current.kind !== SyntaxKind.SourceFile) {
		if (predicate(current)) {
			return current;
		}

		current = current.parent;
	}

	return undefined;
}

const DECLARATION_STATEMENT_KINDS: ReadonlySet<SyntaxKind> = new Set<SyntaxKind>([
	SyntaxKind.FunctionDeclaration,
	SyntaxKind.ClassDeclaration,
	SyntaxKind.InterfaceDeclaration,
	SyntaxKind.TypeAliasDeclaration,
	SyntaxKind.EnumDeclaration,
	SyntaxKind.ModuleDeclaration,
	SyntaxKind.ImportEqualsDeclaration,
	SyntaxKind.ImportDeclaration,
	SyntaxKind.ExportDeclaration,
	SyntaxKind.ExportAssignment,
	SyntaxKind.NamespaceExportDeclaration,
]);

/**
 * Reports whether a statement introduces a declaration.
 *
 * @param node - Candidate statement.
 * @returns True for class, interface, type, enum, module, import, and export statements.
 */
export const isDeclarationStatement = (node: Node): node is Declaration => DECLARATION_STATEMENT_KINDS.has(node.kind);

/**
 * Returns the display text of a diagnostic and its message chain.
 *
 * @param diagnostic - Compiler diagnostic.
 * @returns One message per chain level, joined by newlines.
 */
export const diagnosticText = (diagnostic: Diagnostic): string => {
	const lines = [diagnostic.text];

	for (const nested of diagnostic.messageChain ?? []) {
		lines.push(nested.text);
	}

	return lines.join('\n');
};

/**
 * Resolves the declarations of a symbol.
 *
 * TypeScript 7 returns node handles; the adapter works with resolved nodes.
 *
 * @param symbol - Compiler symbol.
 * @returns Resolved declaration nodes, skipping handles that no longer resolve.
 */
export const declarationsOf = (symbol: CompilerSymbol): readonly Declaration[] => {
	const declarations: Declaration[] = [];

	for (const handle of symbol.declarations) {
		const declaration = handle.resolve();

		if (declaration !== undefined) {
			declarations.push(declaration);
		}
	}

	return declarations;
};

/**
 * Resolves the value declaration of a symbol.
 *
 * @param symbol - Compiler symbol.
 * @returns Resolved value declaration, or undefined.
 */
export const valueDeclarationOf = (symbol: CompilerSymbol): Declaration | undefined => symbol.valueDeclaration?.resolve();

/**
 * Lists every source file of a program in program order.
 *
 * @param program - Loaded program.
 * @returns Program source files.
 */
export const sourceFilesOf = (program: Program): readonly SourceFile[] => {
	const files: SourceFile[] = [];

	for (const fileName of program.getSourceFileNames()) {
		const sourceFile = program.getSourceFile(fileName);

		if (sourceFile !== undefined) {
			files.push(sourceFile);
		}
	}

	return files;
};
