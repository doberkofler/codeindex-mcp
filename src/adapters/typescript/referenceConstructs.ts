import path from 'node:path';
import ts from 'typescript';
import {type IndexedOccurrenceType, type IndexedSymbolType} from '../../core/model.ts';

const {resolve} = path;

/**
 * Language constructs the reference gate must cover.
 *
 * The names are stable report keys, not free-form documentation.
 */
export const REFERENCE_CONSTRUCT_TAGS = [
	'direct-reference',
	'named-import',
	'default-import',
	'namespace-import',
	'named-reexport',
	'barrel-reexport',
	'path-alias',
	'jsx-component',
	'inheritance',
	'override',
	'declaration-merging',
	'type-only-reference',
	'mixed-type-value',
	'destructuring',
	'shorthand-property',
	'javascript',
] as const;

export type ReferenceConstructTagType = (typeof REFERENCE_CONSTRUCT_TAGS)[number];

/** Minimum number of sampled, referenced symbols required per construct. */
export const REFERENCE_CONSTRUCT_QUOTA = 3;

type FileFlagsType = Readonly<{
	readonly hasExportAll: boolean;
	readonly hasNamedReexport: boolean;
	readonly namespaceImports: ReadonlySet<string>;
}>;

type OccurrenceWeightType = 'type' | 'value' | 'none';

type OccurrenceClassificationType = Readonly<{
	readonly tag: ReferenceConstructTagType;
	readonly weight: OccurrenceWeightType;
}>;

export type ReferenceConstructIndexType = Readonly<{
	identifierAt: (filePath: string, startOffset: number, endOffset: number) => ts.Identifier | undefined;
	infer: (
		input: Readonly<{
			symbol: IndexedSymbolType;
			declarationNode: ts.Node;
			occurrences: readonly IndexedOccurrenceType[];
		}>,
	) => readonly ReferenceConstructTagType[];
}>;

const isJavaScriptPath = (filePath: string): boolean => /\.(?:js|jsx|mjs|cjs)$/u.test(filePath);

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
	if (!ts.canHaveModifiers(node)) {
		return false;
	}

	return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
};

const isNode = (value: unknown): value is ts.Node =>
	typeof value === 'object' && value !== null && 'kind' in value && typeof (value as {kind?: unknown}).kind === 'number';

const nameNodeOfDeclaration = (node: ts.Node): ts.Identifier | undefined => {
	if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
		return ts.isIdentifier(node.name) ? node.name : undefined;
	}

	if (ts.isExportSpecifier(node) || ts.isImportSpecifier(node)) {
		return ts.isIdentifier(node.name) ? node.name : undefined;
	}

	if (!('name' in node)) {
		return undefined;
	}

	const {name} = node;

	return isNode(name) && ts.isIdentifier(name) ? name : undefined;
};

const isTypePosition = (node: ts.Identifier): boolean => {
	let current = node.parent;

	while (!ts.isSourceFile(current)) {
		if (ts.isTypeNode(current)) {
			return true;
		}

		if (ts.isImportSpecifier(current)) {
			return current.isTypeOnly;
		}

		if (ts.isImportClause(current)) {
			return current.phaseModifier === ts.SyntaxKind.TypeKeyword;
		}

		if (ts.isStatement(current)) {
			return false;
		}

		current = current.parent;
	}

	return false;
};

const isJsxTagName = (node: ts.Identifier): boolean => {
	const {parent} = node;

	return (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === node;
};

const isHeritageReference = (node: ts.Identifier): boolean => {
	let current = node.parent;

	while (!ts.isSourceFile(current)) {
		if (ts.isExpressionWithTypeArguments(current)) {
			return ts.isHeritageClause(current.parent);
		}

		if (ts.isStatement(current)) {
			return false;
		}

		current = current.parent;
	}

	return false;
};

const enclosingModuleSpecifier = (node: ts.Node): ts.Expression | undefined => {
	let current = node;

	while (!ts.isSourceFile(current)) {
		if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
			return current.moduleSpecifier;
		}

		if (ts.isStatement(current)) {
			return undefined;
		}

		current = current.parent;
	}

	return undefined;
};

const matchesAliasPattern = (specifier: string, patterns: readonly string[]): boolean => {
	for (const pattern of patterns) {
		const star = pattern.indexOf('*');

		if (star === -1) {
			if (specifier === pattern) {
				return true;
			}

			continue;
		}

		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);

		if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
			return true;
		}
	}

	return false;
};

const collectFileFlags = (sourceFile: ts.SourceFile): FileFlagsType => {
	let hasExportAll = false;
	let hasNamedReexport = false;
	const namespaceImports = new Set<string>();

	const visit = (node: ts.Node): void => {
		if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
			if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
				hasExportAll = true;
			} else {
				hasNamedReexport = true;
			}
		}

		if (ts.isNamespaceImport(node)) {
			namespaceImports.add(node.name.text);
		}

		ts.forEachChild(node, visit);
	};

	ts.forEachChild(sourceFile, visit);

	return {hasExportAll, hasNamedReexport, namespaceImports};
};

const collectIdentifiers = (sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Identifier> => {
	const identifiers = new Map<string, ts.Identifier>();

	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			identifiers.set(`${node.getStart(sourceFile)}:${node.end}`, node);
		}

		ts.forEachChild(node, visit);
	};

	ts.forEachChild(sourceFile, visit);

	return identifiers;
};

const declarationTags = (checker: ts.TypeChecker, symbol: IndexedSymbolType, declarationNode: ts.Node): Set<ReferenceConstructTagType> => {
	const tags = new Set<ReferenceConstructTagType>();

	if (isJavaScriptPath(symbol.path)) {
		tags.add('javascript');
	}

	if (ts.isBindingElement(declarationNode)) {
		tags.add('destructuring');
	}

	if (hasModifier(declarationNode, ts.SyntaxKind.OverrideKeyword)) {
		tags.add('override');
	}

	const nameNode = nameNodeOfDeclaration(declarationNode);
	const declarationSymbol = checker.getSymbolAtLocation(nameNode ?? declarationNode);

	if ((declarationSymbol?.declarations?.length ?? 0) > 1) {
		tags.add('declaration-merging');
	}

	return tags;
};

const classifyAliasOccurrence = (node: ts.Identifier): OccurrenceClassificationType | undefined => {
	const {parent} = node;

	if (ts.isImportSpecifier(parent)) {
		return {tag: 'named-import', weight: parent.isTypeOnly ? 'type' : 'none'};
	}

	if (ts.isImportClause(parent)) {
		return {tag: 'default-import', weight: parent.phaseModifier === ts.SyntaxKind.TypeKeyword ? 'type' : 'none'};
	}

	if (ts.isExportSpecifier(parent)) {
		return {tag: 'named-reexport', weight: parent.isTypeOnly ? 'type' : 'none'};
	}

	return undefined;
};

const classifyUsageOccurrence = (node: ts.Identifier, isNamespaceAccess: (candidate: ts.Identifier) => boolean): OccurrenceClassificationType => {
	const weight: OccurrenceWeightType = isTypePosition(node) ? 'type' : 'value';
	const {parent} = node;

	if (isJsxTagName(node)) {
		return {tag: 'jsx-component', weight};
	}

	if (isHeritageReference(node)) {
		return {tag: 'inheritance', weight};
	}

	if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
		return {tag: 'shorthand-property', weight};
	}

	if (isNamespaceAccess(node)) {
		return {tag: 'namespace-import', weight};
	}

	return {tag: 'direct-reference', weight};
};

/**
 * Builds the syntax index used to classify sampled symbols by construct.
 *
 * All information is derived from the compiler program; no source text is
 * retained and no consumer-specific identifiers are encoded.
 *
 * @param program - Loaded TypeScript program.
 * @param rootDir - Absolute indexed workspace root.
 * @param authoredAbsolutePaths - Exact authored files supplied to extraction.
 * @returns A construct index with a single deterministic inference entry point.
 */
export const createReferenceConstructIndex = (
	program: ts.Program,
	rootDir: string,
	authoredAbsolutePaths: ReadonlySet<string>,
): ReferenceConstructIndexType => {
	const checker = program.getTypeChecker();
	const compilerOptions = program.getCompilerOptions();
	const aliasPatterns = Object.keys(compilerOptions.paths ?? {});
	const identifiersByFile = new Map<string, ReadonlyMap<string, ts.Identifier>>();
	const flagsByFile = new Map<string, FileFlagsType>();

	for (const fileName of authoredAbsolutePaths) {
		const sourceFile = program.getSourceFile(fileName);

		if (sourceFile === undefined) {
			continue;
		}

		identifiersByFile.set(fileName, collectIdentifiers(sourceFile));
		flagsByFile.set(fileName, collectFileFlags(sourceFile));
	}

	const identifierAt = (filePath: string, startOffset: number, endOffset: number): ts.Identifier | undefined => {
		const identifiers = identifiersByFile.get(resolve(rootDir, filePath));

		return identifiers?.get(`${startOffset}:${endOffset}`);
	};

	const isNamespaceAccess = (node: ts.Identifier): boolean => {
		const {parent} = node;
		const namespaceImports = flagsByFile.get(node.getSourceFile().fileName)?.namespaceImports;

		if (namespaceImports === undefined) {
			return false;
		}

		if (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isIdentifier(parent.expression)) {
			return namespaceImports.has(parent.expression.text);
		}

		if (ts.isQualifiedName(parent) && parent.right === node && ts.isIdentifier(parent.left)) {
			return namespaceImports.has(parent.left.text);
		}

		return false;
	};

	const moduleTags = (node: ts.Identifier, symbol: IndexedSymbolType): readonly ReferenceConstructTagType[] => {
		const moduleSpecifier = enclosingModuleSpecifier(node);

		if (moduleSpecifier === undefined || !ts.isStringLiteralLike(moduleSpecifier)) {
			return [];
		}

		const tags: ReferenceConstructTagType[] = [];
		const {text} = moduleSpecifier;

		if (matchesAliasPattern(text, aliasPatterns)) {
			tags.push('path-alias');
		}

		if (!ts.isImportDeclaration(moduleSpecifier.parent)) {
			return tags;
		}

		const {fileName} = node.getSourceFile();
		const {resolvedModule} = ts.resolveModuleName(text, fileName, compilerOptions, ts.sys);
		const resolvedFile = resolvedModule === undefined ? undefined : resolve(resolvedModule.resolvedFileName);
		const flags = resolvedFile === undefined ? undefined : flagsByFile.get(resolvedFile);

		if (resolvedFile === undefined || resolvedFile === resolve(rootDir, symbol.path)) {
			return tags;
		}

		if (flags?.hasExportAll === true) {
			tags.push('barrel-reexport');
		}

		if (flags?.hasNamedReexport === true) {
			tags.push('named-reexport');
		}

		return tags;
	};

	return {
		identifierAt,
		infer: ({symbol, declarationNode, occurrences}) => {
			const tags = declarationTags(checker, symbol, declarationNode);
			const weights: Record<OccurrenceWeightType, number> = {type: 0, value: 0, none: 0};

			for (const occurrence of occurrences) {
				if (occurrence.role !== 'reference') {
					continue;
				}

				const node = identifierAt(occurrence.path, occurrence.startOffset, occurrence.endOffset);

				if (node === undefined) {
					continue;
				}

				for (const tag of moduleTags(node, symbol)) {
					tags.add(tag);
				}

				const classification = classifyAliasOccurrence(node) ?? classifyUsageOccurrence(node, isNamespaceAccess);
				const {tag, weight} = classification;
				tags.add(tag);
				weights[weight] += 1;
			}

			if (weights.type > 0 && weights.value === 0) {
				tags.add('type-only-reference');
			}

			if (weights.type > 0 && weights.value > 0) {
				tags.add('mixed-type-value');
			}

			return REFERENCE_CONSTRUCT_TAGS.filter((tag) => tags.has(tag));
		},
	};
};
