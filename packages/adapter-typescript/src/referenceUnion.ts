import {readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {type AdapterConfigType, type IndexedSymbolType, type ScanResultType, type SourceFileType} from '@codeindex/adapter-sdk';
import {loadTypeScriptProject, type LoadedProjectType} from './loadProject.ts';
import {mergeProjectFiles} from './projectFiles.ts';
import {createReferenceConstructIndex, type ReferenceConstructIndexType} from './referenceConstructs.ts';
import {normalizeReferenceLocations, type ReferenceLocationType} from './referenceLocations.ts';
import {buildDefinitionIndex, createLanguageService, lookupReferences, type LocatedDeclarationType, type ReferenceLookupType} from './referenceLookup.ts';
import {type ReferenceSkipReasonType} from './referenceGate.ts';

/** One production project context used as a language-service truth source. */
export type ReferenceUnionContextType = Readonly<{
	readonly name: string;
	readonly project: LoadedProjectType;
	readonly service: ts.LanguageService;
	readonly constructs: ReferenceConstructIndexType;
	readonly files: readonly SourceFileType[];
	readonly locatedBySymbol: ReadonlyMap<string, LocatedDeclarationType | null>;
}>;

/** The union of every configured production context. */
export type ReferenceUnionType = Readonly<{
	readonly rootDir: string;
	readonly contexts: readonly ReferenceUnionContextType[];
	readonly files: readonly SourceFileType[];
	readonly authoredPaths: ReadonlySet<string>;
	readonly authoredAbsolutePaths: ReadonlySet<string>;
}>;

const sourceBytes = (absolutePath: string): Uint8Array | undefined => {
	try {
		return readFileSync(absolutePath);
	} catch {
		return undefined;
	}
};

/**
 * Loads every configured project context with a fresh compiler program.
 *
 * The files are merged exactly as the production extractor merges them, so
 * imported authored files outside a project include participate in truth.
 *
 * @param config - Resolved project configuration.
 * @param scan - Workspace scan manifest.
 * @param symbols - Merged production symbols.
 * @returns Contexts, the union of authored files, and lookup sets.
 */
export const createReferenceUnion = (config: AdapterConfigType, scan: ScanResultType, symbols: readonly IndexedSymbolType[]): ReferenceUnionType => {
	const contexts = config.projects.map((context): ReferenceUnionContextType => {
		const project = loadTypeScriptProject(config, context.projectFilePath);
		const files = mergeProjectFiles(config, scan, project, sourceBytes);
		const authoredAbsolutePaths = new Set(files.map((file) => file.absolutePath));

		return {
			name: context.name,
			project,
			service: createLanguageService(config, project.program),
			constructs: createReferenceConstructIndex(project.program, config.rootDir, authoredAbsolutePaths),
			files,
			locatedBySymbol: buildDefinitionIndex(project.program, symbols, files),
		};
	});
	const mergedFiles = new Map<string, SourceFileType>();

	for (const context of contexts) {
		for (const file of context.files) {
			mergedFiles.set(file.path, file);
		}
	}

	const files = [...mergedFiles.values()].sort((left, right) => left.path.localeCompare(right.path));

	return {
		rootDir: config.rootDir,
		contexts,
		files,
		authoredPaths: new Set(files.map((file) => file.path)),
		authoredAbsolutePaths: new Set(files.map((file) => file.absolutePath)),
	};
};

/**
 * Looks up one symbol's truth in every context that can locate its declaration.
 *
 * Locations from different contexts are deduplicated by exact path, range, and
 * role. A context that cannot resolve the symbol is ignored while another
 * context succeeds; failure across every context survives as a skip.
 *
 * @param input - Union, symbol, and configuration.
 * @returns Language-service locations or a skip reason.
 */
export const lookupUnionReferences = (
	input: Readonly<{
		config: AdapterConfigType;
		union: ReferenceUnionType;
		symbol: IndexedSymbolType;
	}>,
): ReferenceLookupType => {
	const locations: ReferenceLocationType[] = [];
	let located = false;
	let skip: ReferenceSkipReasonType | null = null;

	for (const context of input.union.contexts) {
		const declaration = context.locatedBySymbol.get(input.symbol.id) ?? null;

		if (declaration === null) {
			continue;
		}

		located = true;
		const lookup = lookupReferences({
			config: input.config,
			program: context.project.program,
			checker: context.project.checker,
			service: context.service,
			constructs: context.constructs,
			symbol: input.symbol,
			located: declaration,
			authoredPaths: input.union.authoredPaths,
		});

		if ('skip' in lookup) {
			({skip} = lookup);
			continue;
		}

		locations.push(...lookup.locations);
	}

	if (!located) {
		return {skip: 'declaration_not_located'};
	}

	if (!locations.some((location) => location.role === 'definition')) {
		return {skip: skip ?? 'reference_lookup_failed'};
	}

	return {locations: normalizeReferenceLocations(locations)};
};

type SyntaxClassType = 'direct_external' | 'namespace_import' | null;

const realName = (fileName: string): string => ts.sys.realpath?.(fileName) ?? fileName;

const namespaceNamesOf = (sourceFile: ts.SourceFile): ReadonlySet<string> => {
	const names = new Set<string>();

	const visit = (node: ts.Node): void => {
		if (ts.isNamespaceImport(node)) {
			names.add(node.name.text);
		}

		ts.forEachChild(node, visit);
	};

	ts.forEachChild(sourceFile, visit);

	return names;
};

const isNamespaceUse = (node: ts.Identifier, namespaceNames: ReadonlySet<string>): boolean => {
	if (ts.isNamespaceImport(node)) {
		return true;
	}

	const {parent} = node;
	const left =
		ts.isPropertyAccessExpression(parent) && parent.name === node
			? parent.expression
			: ts.isQualifiedName(parent) && parent.right === node
				? parent.left
				: undefined;

	return left !== undefined && ts.isIdentifier(left) && namespaceNames.has(left.text);
};

/**
 * Creates the syntax classifier used for unmatched truth locations.
 *
 * The classifier distinguishes direct external targets and namespace bindings
 * from a genuine extraction gap. It never guesses from identifier text alone.
 *
 * @param union - Production context union.
 * @returns A classifier keyed by path and exact span.
 */
export const createReferenceSyntaxClassifier = (union: ReferenceUnionType): ((path: string, startOffset: number, endOffset: number) => SyntaxClassType) => {
	const authored = new Set([...union.authoredAbsolutePaths].map((fileName) => realName(fileName)));
	const namespaceCache = new Map<string, ReadonlySet<string>>();

	return (filePath, startOffset, endOffset) => {
		const absolutePath = path.resolve(union.rootDir, filePath);

		for (const context of union.contexts) {
			const sourceFile = context.project.program.getSourceFile(absolutePath);

			if (sourceFile === undefined) {
				continue;
			}

			const node = context.constructs.identifierAt(filePath, startOffset, endOffset);

			if (node === undefined) {
				continue;
			}

			if (namespaceCache.get(absolutePath) === undefined) {
				namespaceCache.set(absolutePath, namespaceNamesOf(sourceFile));
			}

			if (isNamespaceUse(node, namespaceCache.get(absolutePath) ?? new Set())) {
				return 'namespace_import';
			}

			const raw = context.project.checker.getSymbolAtLocation(node);
			const target = raw === undefined || (raw.flags & ts.SymbolFlags.Alias) === 0 ? raw : context.project.checker.getAliasedSymbol(raw);
			const declarations = target?.declarations ?? [];

			if (declarations.length > 0 && declarations.every((declaration) => !authored.has(realName(declaration.getSourceFile().fileName)))) {
				return 'direct_external';
			}

			return null;
		}

		return null;
	};
};
