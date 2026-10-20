import ts from 'typescript';
import {type FactAddressType, type FactExposureType, type FactRangeType, type FactSiteKindType} from '../../core/facts/index.ts';
import {type SourceFileType} from '../../core/model.ts';
import {nameNodeOf} from './publicationAddress.ts';
import {type ExtractionRuntimeType, lexicalSegmentsOf, symbolForDeclaration, symbolForTsSymbol} from './extractionRuntime.ts';

const DECLARED_SITE_KIND: FactSiteKindType = 'declared';

/** One canonical binding accumulated before finalization. */
export type BindingDraftType = {
	readonly symbolId: string;
	readonly segments: FactAddressType;
	exposure: FactExposureType;
	readonly sites: Map<string, {kind: FactSiteKindType; path: string; range: FactRangeType}>;
};

/** One published root binding. */
export type RootDraftType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly tsSymbol: ts.Symbol;
	readonly site: Readonly<{kind: FactSiteKindType; path: string; range: FactRangeType}>;
	readonly external: boolean;
}>;

/** One projected surface origin. */
type OriginDraftType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly context: string;
	readonly rootSymbolId: string;
	readonly rootSegments: FactAddressType;
	readonly relativeSegments: FactAddressType;
}>;

/** Mutable binding, root, and projection facts for one context. */
export type FactSinkType = {
	readonly bindings: Map<string, BindingDraftType>;
	readonly origins: OriginDraftType[];
	readonly roots: RootDraftType[];
	readonly reachable: Set<string>;
	readonly rootKeys: Set<string>;
	readonly surfaceFlags: {anonymous: number; inherited: number; depthOne: number};
	maxAddresses: number;
	maxSteps: number;
};

const addressKey = (segments: FactAddressType): string => JSON.stringify(segments);

export const bindingKey = (symbolId: string, segments: FactAddressType): string => `${symbolId}\u0000${addressKey(segments)}`;

const rangeOfNode = (sourceFile: ts.SourceFile, node: ts.Node): FactRangeType => {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	const end = sourceFile.getLineAndCharacterOfPosition(node.end);

	return {
		startLine: start.line + 1,
		startColumn: start.character + 1,
		endLine: end.line + 1,
		endColumn: end.character + 1,
		startOffset: node.getStart(sourceFile),
		endOffset: node.end,
	};
};

const defaultTokenOf = (sourceFile: ts.SourceFile, node: ts.Node): ts.Node | null => {
	for (const child of node.getChildren(sourceFile)) {
		if (child.kind === ts.SyntaxKind.DefaultKeyword) {
			return child;
		}
	}

	return null;
};

const starTokenOf = (sourceFile: ts.SourceFile, node: ts.Node): ts.Node | null => {
	for (const child of node.getChildren(sourceFile)) {
		if (child.kind === ts.SyntaxKind.AsteriskToken) {
			return child;
		}
	}

	return null;
};

const addBinding = (sink: FactSinkType, symbolId: string, segments: FactAddressType): BindingDraftType => {
	const key = bindingKey(symbolId, segments);
	const existing = sink.bindings.get(key);

	if (existing !== undefined) {
		return existing;
	}

	const draft: BindingDraftType = {symbolId, segments, exposure: 'internal', sites: new Map()};
	sink.bindings.set(key, draft);
	return draft;
};

const siteRank = (kind: FactSiteKindType): number =>
	kind === 'declared' ? 0 : kind === 'default' ? 1 : kind === 'alias' ? 2 : kind === 'reexport' ? 3 : kind === 'wildcard' ? 4 : kind === 'commonjs' ? 5 : 6;

/**
 * Adds one source site to a binding, keeping the strongest kind per location.
 *
 * @param sink - Fact sink.
 * @param site - Binding identity, kind, path, and range.
 */
export const addSite = (
	sink: FactSinkType,
	site: Readonly<{symbolId: string; segments: FactAddressType; kind: FactSiteKindType; pathName: string; range: FactRangeType}>,
): void => {
	const draft = addBinding(sink, site.symbolId, site.segments);
	const key = [site.pathName, String(site.range.startOffset)].join('\u0000');
	const existing = draft.sites.get(key);

	if (existing === undefined || siteRank(site.kind) < siteRank(existing.kind)) {
		draft.sites.set(key, {kind: site.kind, path: site.pathName, range: site.range});
	}
};

/**
 * Adds one published root binding.
 *
 * @param sink - Fact sink.
 * @param root - Root binding draft.
 */
const addRoot = (sink: FactSinkType, root: RootDraftType): void => {
	const key = bindingKey(root.symbolId, root.segments);

	if (sink.rootKeys.has(key)) {
		return;
	}

	sink.rootKeys.add(key);
	const draft = addBinding(sink, root.symbolId, root.segments);
	draft.exposure = 'published';

	if (root.site.range.endOffset > root.site.range.startOffset) {
		addSite(sink, {symbolId: root.symbolId, segments: root.segments, kind: root.site.kind, pathName: root.site.path, range: root.site.range});
	}

	sink.roots.push(root);
};

const isNode = (value: unknown): value is ts.Node => typeof value === 'object' && value !== null && 'kind' in value && typeof value['kind'] === 'number';

const exportClauseNames = (statement: ts.ExportDeclaration): readonly string[] => {
	if (statement.exportClause === undefined) {
		return [];
	}

	return ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map((element) => element.name.text) : [statement.exportClause.name.text];
};

const exportedDeclarationNames = (statement: ts.Statement): readonly string[] => {
	const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);

	if (!exported) {
		return [];
	}

	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []));
	}

	const named = 'name' in statement ? statement.name : undefined;

	return isNode(named) && ts.isIdentifier(named) ? [named.text] : [];
};

const explicitExportNames = (sourceFile: ts.SourceFile): ReadonlySet<string> => {
	const names = new Set<string>();

	for (const statement of sourceFile.statements) {
		if (ts.isExportDeclaration(statement)) {
			for (const name of exportClauseNames(statement)) {
				names.add(name);
			}

			continue;
		}

		if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
			names.add('default');
			continue;
		}

		for (const name of exportedDeclarationNames(statement)) {
			names.add(name);
		}
	}

	return names;
};

const starDeclarations = (sourceFile: ts.SourceFile): readonly ts.ExportDeclaration[] =>
	sourceFile.statements.filter(
		(statement): statement is ts.ExportDeclaration =>
			ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && statement.exportClause === undefined,
	);

const starSiteOf = (
	runtime: ExtractionRuntimeType,
	name: string,
	explicitNames: ReadonlySet<string>,
	stars: readonly ts.ExportDeclaration[],
): Readonly<{kind: FactSiteKindType; path: string; range: FactRangeType}> | null => {
	if (explicitNames.has(name)) {
		return null;
	}

	for (const star of stars) {
		const file = star.getSourceFile();
		const pathName = runtime.pathByAbsolute.get(file.fileName);
		const token = starTokenOf(file, star);

		if (pathName !== undefined) {
			return {kind: 'wildcard', path: pathName, range: token === null ? rangeOfNode(file, star) : rangeOfNode(file, token)};
		}
	}

	return null;
};

const declarationSiteOf = (
	runtime: ExtractionRuntimeType,
	declaration: ts.Declaration,
): Readonly<{kind: FactSiteKindType; path: string; range: FactRangeType}> | null => {
	const file = declaration.getSourceFile();
	const pathName = runtime.pathByAbsolute.get(file.fileName);

	if (pathName === undefined) {
		return null;
	}

	if (ts.isExportSpecifier(declaration)) {
		const exportDeclaration = declaration.parent.parent;
		const kind: FactSiteKindType = ts.isExportDeclaration(exportDeclaration) && exportDeclaration.moduleSpecifier !== undefined ? 'reexport' : 'alias';
		return {kind, path: pathName, range: rangeOfNode(file, declaration.name)};
	}

	if (ts.isNamespaceExport(declaration)) {
		return {kind: 'alias', path: pathName, range: rangeOfNode(file, declaration.name)};
	}

	if (ts.isExportAssignment(declaration)) {
		const token = defaultTokenOf(file, declaration);
		return {kind: 'default', path: pathName, range: token === null ? rangeOfNode(file, declaration) : rangeOfNode(file, token)};
	}

	const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;

	if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false) {
		const token = defaultTokenOf(file, declaration);
		return token === null ? null : {kind: 'default', path: pathName, range: rangeOfNode(file, token)};
	}

	const nameNode = nameNodeOf(declaration);

	return nameNode === undefined ? null : {kind: 'declared', path: pathName, range: rangeOfNode(file, nameNode)};
};

const rootSiteOf = (
	runtime: ExtractionRuntimeType,
	input: Readonly<{exported: ts.Symbol; name: string; explicitNames: ReadonlySet<string>; stars: readonly ts.ExportDeclaration[]}>,
): Readonly<{kind: FactSiteKindType; path: string; range: FactRangeType}> | null => {
	const declarations = input.exported.declarations ?? [];
	const star = starSiteOf(runtime, input.name, input.explicitNames, input.stars);

	if (star !== null) {
		return star;
	}

	for (const declaration of declarations) {
		const site = declarationSiteOf(runtime, declaration);

		if (site !== null) {
			return site;
		}
	}

	return null;
};

const moduleTargetIsExternal = (runtime: ExtractionRuntimeType, target: ts.Symbol): boolean => {
	const declarations = target.declarations ?? [];

	if (declarations.length === 0) {
		return false;
	}

	const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

	for (const declaration of declarations) {
		const sourceFile = declaration.getSourceFile();

		if (runtime.authoredPaths.has(sourceFile.fileName)) {
			return false;
		}

		if (sourceFile.isDeclarationFile) {
			const base = sourceFile.fileName.replace(/\.d\.(?:ts|mts|cts)$/u, '');

			if (extensions.some((extension) => runtime.authoredPaths.has(`${base}${extension}`))) {
				return false;
			}
		}
	}

	return true;
};

const externalStarNamesOf = (runtime: ExtractionRuntimeType, stars: readonly ts.ExportDeclaration[]): ReadonlySet<string> => {
	const names = new Set<string>();

	for (const star of stars) {
		const target = star.moduleSpecifier === undefined ? undefined : runtime.checker.getSymbolAtLocation(star.moduleSpecifier);

		if (target === undefined || !moduleTargetIsExternal(runtime, target)) {
			continue;
		}

		for (const exported of runtime.checker.getExportsOfModule(target)) {
			names.add(exported.getName());
		}
	}

	return names;
};

const rootSymbolIdOf = (runtime: ExtractionRuntimeType, exported: ts.Symbol, pathName: string, name: string): string | null =>
	symbolForTsSymbol(runtime, exported) ??
	runtime.symbolIdByPathAndName.get(`${pathName}\u0000${name}`) ??
	(exported.declarations ?? []).map((declaration) => symbolForDeclaration(runtime, declaration)).find((id) => id !== null) ??
	null;

const addModuleRoots = (runtime: ExtractionRuntimeType, sink: FactSinkType, file: SourceFileType, sourceFile: ts.SourceFile): void => {
	const moduleSymbol = runtime.checker.getSymbolAtLocation(sourceFile);
	const explicitNames = explicitExportNames(sourceFile);
	const stars = starDeclarations(sourceFile);
	const externalStarNames = externalStarNamesOf(runtime, stars);

	for (const exported of moduleSymbol === undefined ? [] : runtime.checker.getExportsOfModule(moduleSymbol)) {
		const name = exported.getName();

		if (externalStarNames.has(name) && !explicitNames.has(name)) {
			continue;
		}
		const symbolId = rootSymbolIdOf(runtime, exported, file.path, name);

		if (symbolId === null) {
			continue;
		}

		const target = (exported.flags & ts.SymbolFlags.Alias) === 0 ? exported : runtime.checker.getAliasedSymbol(exported);
		const candidate = runtime.candidateBySymbolId.get(symbolId);
		const external = candidate?.externalTarget !== null && candidate?.externalTarget !== undefined;
		const site =
			rootSiteOf(runtime, {exported, name, explicitNames, stars}) ??
			(candidate === undefined
				? {
						kind: DECLARED_SITE_KIND,
						path: file.path,
						range: rangeOfNode(sourceFile, sourceFile),
					}
				: {
						kind: DECLARED_SITE_KIND,
						path: candidate.path,
						range: candidate.primary.range,
					});
		const siteKind = external && site.kind === 'alias' ? DECLARED_SITE_KIND : site.kind;

		addRoot(sink, {
			symbolId,
			segments: [
				['module', file.path],
				['member', name],
			],
			tsSymbol: target,
			site: {...site, kind: siteKind},
			external,
		});
	}
};

const topLevelDeclarations = (statement: ts.Statement): readonly ts.Declaration[] =>
	ts.isVariableStatement(statement) ? statement.declarationList.declarations : ts.isDeclarationStatement(statement) ? [statement] : [];

const addScriptRoots = (runtime: ExtractionRuntimeType, sink: FactSinkType, file: SourceFileType, sourceFile: ts.SourceFile): void => {
	for (const statement of sourceFile.statements) {
		for (const declaration of topLevelDeclarations(statement)) {
			const nameNode = nameNodeOf(declaration);
			const symbolId = nameNode === undefined ? null : symbolForDeclaration(runtime, declaration);
			const tsSymbol = nameNode === undefined ? null : (runtime.checker.getSymbolAtLocation(nameNode) ?? null);

			if (symbolId === null || tsSymbol === null) {
				continue;
			}

			addRoot(sink, {
				symbolId,
				segments: lexicalSegmentsOf(runtime, symbolId),
				tsSymbol,
				site: {kind: DECLARED_SITE_KIND, path: file.path, range: rangeOfNode(sourceFile, nameNode ?? declaration)},
				external: false,
			});
		}
	}
};

/**
 * Adds every published root binding for one context.
 *
 * @param runtime - Extraction state.
 * @param sink - Fact sink.
 */
export const addPublishedRoots = (runtime: ExtractionRuntimeType, sink: FactSinkType): void => {
	for (const file of runtime.input.files) {
		const sourceFile = runtime.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined || sourceFile.isDeclarationFile) {
			continue;
		}

		if (ts.isExternalModule(sourceFile)) {
			addModuleRoots(runtime, sink, file, sourceFile);
		} else {
			addScriptRoots(runtime, sink, file, sourceFile);
		}
	}
};

/**
 * Creates an empty fact sink.
 *
 * @returns Mutable binding and projection state.
 */
export const createFactSink = (): FactSinkType => ({
	bindings: new Map(),
	origins: [],
	roots: [],
	reachable: new Set(),
	rootKeys: new Set(),
	surfaceFlags: {anonymous: 0, inherited: 0, depthOne: 0},
	maxAddresses: 0,
	maxSteps: 0,
});

/**
 * Creates one canonical binding draft.
 *
 * @param sink - Fact sink.
 * @param symbolId - Stored symbol identifier.
 * @param segments - Binding address.
 * @returns The existing or new binding draft.
 */
export const ensureBinding = (sink: FactSinkType, symbolId: string, segments: FactAddressType): BindingDraftType => addBinding(sink, symbolId, segments);
