import path from 'node:path';
import ts from 'typescript';
import {toRepositoryPath} from '../../config/config.ts';
import {debugFor} from '../../logging/debug.ts';
import {
	type DependencyExtractionResultType,
	type DependencyKindType,
	type IndexedDependencyBindingType,
	type IndexedDependencyEdgeType,
	type SourceFileType,
} from '../../index/model.ts';
import {type LoadedProjectType} from './loadProject.ts';
import {createSymbolId} from './symbolIdentity.ts';

const debug = debugFor('dependencies');

type DependencyInputType = Readonly<{
	readonly project: LoadedProjectType;
	readonly files: readonly SourceFileType[];
	readonly projectId: string;
	readonly rootDir: string;
}>;

type PendingBindingType = Omit<IndexedDependencyBindingType, 'edgeId'>;

type FoundDependencyType = Readonly<{
	readonly literal: ts.StringLiteralLike;
	readonly kind: DependencyKindType;
	readonly typeOnly: boolean;
	readonly bindings: readonly PendingBindingType[];
}>;

const nameText = (name: ts.ModuleExportName | ts.Identifier): string => name.text;

const binding = (input: Readonly<Omit<PendingBindingType, 'position'>>): PendingBindingType => ({position: 0, ...input});

const isTypeOnlyClause = (clause: ts.ImportClause): boolean => clause.phaseModifier === ts.SyntaxKind.TypeKeyword;

const importBindings = (clause: ts.ImportClause | undefined): readonly PendingBindingType[] => {
	if (clause === undefined) {
		return [];
	}

	const bindings: PendingBindingType[] = [];
	const clauseTypeOnly = isTypeOnlyClause(clause);

	if (clause.name !== undefined) {
		bindings.push(binding({kind: 'default', importedName: 'default', exportedName: null, localName: clause.name.text, typeOnly: clauseTypeOnly}));
	}

	const {namedBindings} = clause;

	if (namedBindings !== undefined) {
		if (ts.isNamespaceImport(namedBindings)) {
			bindings.push(binding({kind: 'namespace', importedName: '*', exportedName: null, localName: namedBindings.name.text, typeOnly: clauseTypeOnly}));
		} else {
			for (const element of namedBindings.elements) {
				const typeOnly = clauseTypeOnly || element.isTypeOnly;
				const importedName = element.propertyName === undefined ? element.name.text : nameText(element.propertyName);

				bindings.push(binding({kind: 'named', importedName, exportedName: null, localName: element.name.text, typeOnly}));
			}
		}
	}

	return bindings;
};

const exportBindings = (declaration: ts.ExportDeclaration): readonly PendingBindingType[] => {
	const {exportClause} = declaration;

	if (exportClause === undefined) {
		return [binding({kind: 'all', importedName: '*', exportedName: '*', localName: null, typeOnly: declaration.isTypeOnly})];
	}

	if (ts.isNamespaceExport(exportClause)) {
		return [
			binding({
				kind: 'namespace',
				importedName: '*',
				exportedName: nameText(exportClause.name),
				localName: null,
				typeOnly: declaration.isTypeOnly,
			}),
		];
	}

	return exportClause.elements.map((element) => {
		const importName = element.propertyName === undefined ? element.name.text : nameText(element.propertyName);

		return binding({
			kind: 'named',
			importedName: importName,
			exportedName: element.name.text,
			localName: null,
			typeOnly: declaration.isTypeOnly || element.isTypeOnly,
		});
	});
};

const staticImport = (node: ts.ImportDeclaration): FoundDependencyType | null => {
	if (!ts.isStringLiteral(node.moduleSpecifier)) {
		return null;
	}

	return {
		literal: node.moduleSpecifier,
		kind: node.importClause === undefined ? 'side-effect' : 'import',
		typeOnly: node.importClause === undefined ? false : isTypeOnlyClause(node.importClause),
		bindings: importBindings(node.importClause),
	};
};

const staticExport = (node: ts.ExportDeclaration): FoundDependencyType | null => {
	if (node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) {
		return null;
	}

	return {
		literal: node.moduleSpecifier,
		kind: node.exportClause === undefined ? 'export-all' : 'export',
		typeOnly: node.isTypeOnly,
		bindings: exportBindings(node),
	};
};

const importEquals = (node: ts.ImportEqualsDeclaration): FoundDependencyType | null => {
	const {moduleReference} = node;

	if (!ts.isExternalModuleReference(moduleReference) || !ts.isStringLiteral(moduleReference.expression)) {
		return null;
	}

	return {
		literal: moduleReference.expression,
		kind: 'import-equals',
		typeOnly: node.isTypeOnly,
		bindings: [binding({kind: 'import-equals', importedName: null, exportedName: null, localName: node.name.text, typeOnly: node.isTypeOnly})],
	};
};

const dynamicImport = (node: ts.CallExpression): FoundDependencyType | null => {
	if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
		return null;
	}

	const [argument] = node.arguments;
	return argument !== undefined && ts.isStringLiteralLike(argument) ? {literal: argument, kind: 'dynamic-import', typeOnly: false, bindings: []} : null;
};

const importType = (node: ts.ImportTypeNode): FoundDependencyType | null => {
	if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) {
		return null;
	}

	return {literal: node.argument.literal, kind: 'import-type', typeOnly: true, bindings: []};
};

const foundDependency = (node: ts.Node): FoundDependencyType | null => {
	if (ts.isImportDeclaration(node)) {
		return staticImport(node);
	}

	if (ts.isExportDeclaration(node)) {
		return staticExport(node);
	}

	if (ts.isImportEqualsDeclaration(node)) {
		return importEquals(node);
	}

	if (ts.isCallExpression(node)) {
		return dynamicImport(node);
	}

	if (ts.isImportTypeNode(node)) {
		return importType(node);
	}

	return null;
};

const isPackageSpecifier = (specifier: string): boolean =>
	!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#') && !specifier.includes(':');

const packageNameOf = (specifier: string): string | null => {
	if (!isPackageSpecifier(specifier)) {
		return null;
	}

	const segments = specifier.split('/');

	if (specifier.startsWith('@')) {
		return segments.length >= 2 && segments[0] !== undefined && segments[1] !== undefined ? `${segments[0]}/${segments[1]}` : null;
	}

	return segments[0] === undefined || segments[0].length === 0 ? null : segments[0];
};

const aliasPrefixesOf = (options: ts.CompilerOptions): readonly string[] => Object.keys(options.paths ?? {}).map((pattern) => pattern.replace(/\/\*$/u, ''));

const resolvedTargetPath = (
	input: Readonly<{
		project: LoadedProjectType;
		authoredPaths: ReadonlySet<string>;
		rootDir: string;
		sourceFile: ts.SourceFile;
		cache: ts.ModuleResolutionCache;
	}>,
	literal: ts.StringLiteralLike,
): string | null => {
	const mode = input.project.program.getModeForUsageLocation(input.sourceFile, literal);
	const resolved = ts.resolveModuleName(
		literal.text,
		input.sourceFile.fileName,
		input.project.program.getCompilerOptions(),
		ts.sys,
		input.cache,
		undefined,
		mode,
	).resolvedModule?.resolvedFileName;

	if (resolved === undefined || !input.authoredPaths.has(path.resolve(resolved))) {
		return null;
	}

	try {
		return toRepositoryPath(input.rootDir, resolved);
	} catch {
		return null;
	}
};

/**
 * Extracts authored import and export edges from the loaded TypeScript program.
 *
 * Package names are normalized only when the specifier does not resolve to an
 * authored file. TypeScript path aliases therefore stay authored targets instead
 * of being reported as npm packages.
 *
 * @param input - Loaded program, authored files, and project identity.
 * @returns Persisted dependency edges and their binding details.
 */
export const extractDependencyFacts = (input: DependencyInputType): DependencyExtractionResultType => {
	const startedAt = performance.now();
	const authoredPaths = new Set(input.files.map((file) => path.resolve(file.absolutePath)));
	const aliasPrefixes = aliasPrefixesOf(input.project.program.getCompilerOptions());
	const cache = ts.createModuleResolutionCache(input.rootDir, (fileName) => fileName, input.project.program.getCompilerOptions());
	const edges: IndexedDependencyEdgeType[] = [];
	const bindings: IndexedDependencyBindingType[] = [];

	for (const file of input.files) {
		const sourceFile = input.project.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		const visit = (node: ts.Node): void => {
			const found = foundDependency(node);

			if (found !== null) {
				const targetPath = resolvedTargetPath({project: input.project, authoredPaths, rootDir: input.rootDir, sourceFile, cache}, found.literal);
				const alias = aliasPrefixes.find((prefix) => found.literal.text === prefix || found.literal.text.startsWith(`${prefix}/`));
				const normalizedPackage = targetPath !== null || alias !== undefined ? null : packageNameOf(found.literal.text);
				const start = sourceFile.getLineAndCharacterOfPosition(found.literal.getStart(sourceFile));
				const end = sourceFile.getLineAndCharacterOfPosition(found.literal.end);
				const id = createSymbolId({
					projectId: input.projectId,
					path: file.path,
					startOffset: found.literal.getStart(sourceFile),
					kind: found.kind,
					name: found.literal.text,
				});

				edges.push({
					id,
					sourcePath: file.path,
					targetPath,
					rawSpecifier: found.literal.text,
					normalizedPackage,
					kind: found.kind,
					typeOnly: found.typeOnly,
					startLine: start.line + 1,
					startColumn: start.character + 1,
					endLine: end.line + 1,
					endColumn: end.character + 1,
					startOffset: found.literal.getStart(sourceFile),
					endOffset: found.literal.end,
				});

				for (const [position, entry] of found.bindings.entries()) {
					bindings.push({...entry, edgeId: id, position});
				}
			}

			ts.forEachChild(node, visit);
		};

		ts.forEachChild(sourceFile, visit);
	}

	edges.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.startOffset - right.startOffset || left.id.localeCompare(right.id));
	bindings.sort((left, right) => left.edgeId.localeCompare(right.edgeId) || left.position - right.position);
	debug('dependency extraction complete', {
		edges: edges.length,
		bindings: bindings.length,
		packages: edges.filter((edge) => edge.normalizedPackage !== null).length,
		durationMs: Math.round(performance.now() - startedAt),
	});

	return {edges, bindings};
};
