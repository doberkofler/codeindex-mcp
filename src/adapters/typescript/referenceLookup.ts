import ts from 'typescript';
import {type ConfigType} from '../../core/config/config.ts';
import {type IndexedSymbolType, type SourceFileType} from '../../core/model.ts';
import {candidateNameNode} from './extractSymbols.ts';
import {referenceLocationKey, toLocationPath, type ReferenceLocationType} from './referenceLocations.ts';
import {resolveOccurrenceSymbol} from './resolveSymbols.ts';
import {type ReferenceConstructIndexType} from './referenceConstructs.ts';
import {type ReferenceSkipReasonType} from './referenceGate.ts';

export type LocatedDeclarationType = Readonly<{
	readonly declarationNode: ts.Node;
	readonly nameNode: ts.Node;
}>;

export type ReferenceLookupType = Readonly<{readonly locations: readonly ReferenceLocationType[]}> | Readonly<{readonly skip: ReferenceSkipReasonType}>;

/**
 * Maps every indexed symbol to the declaration name node it came from.
 *
 * The extractor already recorded the declaration start offset. Rebuilding the
 * name span from the program keeps verification independent of extractor
 * internals while still rejecting symbols whose declaration cannot be found.
 *
 * @param program - Loaded TypeScript program.
 * @param symbols - Indexed symbols.
 * @param files - Exact authored files supplied to extraction.
 * @returns A lookup keyed by symbol identifier; missing declarations map to null.
 */
export const buildDefinitionIndex = (
	program: ts.Program,
	symbols: readonly IndexedSymbolType[],
	files: readonly SourceFileType[],
): ReadonlyMap<string, LocatedDeclarationType | null> => {
	const byFile = new Map<string, ReadonlyMap<number, LocatedDeclarationType>>();

	for (const file of files) {
		const sourceFile = program.getSourceFile(file.absolutePath);
		const located = new Map<number, LocatedDeclarationType>();

		if (sourceFile !== undefined) {
			const visit = (node: ts.Node): void => {
				const nameNode = candidateNameNode(node);

				if (nameNode !== undefined) {
					located.set(node.getStart(sourceFile), {declarationNode: node, nameNode});
				}

				ts.forEachChild(node, visit);
			};

			ts.forEachChild(sourceFile, visit);
		}

		byFile.set(file.path, located);
	}

	return new Map(
		symbols.map((symbol) => {
			const located = byFile.get(symbol.path)?.get(symbol.startOffset);

			return [symbol.id, located ?? null] as const;
		}),
	);
};

/**
 * Creates a language service over the same root names and compiler options as
 * the extraction program.
 *
 * @param config - Resolved project configuration.
 * @param program - Extraction program.
 * @returns A language service for reference queries.
 */
export const createLanguageService = (config: ConfigType, program: ts.Program): ts.LanguageService => {
	const rootNames = [...program.getRootFileNames()];
	const options = program.getCompilerOptions();

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => rootNames,
		getScriptVersion: () => '0',
		getScriptSnapshot: (fileName) => {
			const text = ts.sys.readFile(fileName);
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => config.rootDir,
		getCompilationSettings: () => options,
		getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
		fileExists: (fileName) => ts.sys.fileExists(fileName),
		readFile: (fileName) => ts.sys.readFile(fileName),
		readDirectory: (...args: Parameters<typeof ts.sys.readDirectory>) => ts.sys.readDirectory(...args),
	};

	return ts.createLanguageService(host);
};

const canonicalDefinitions = (checker: ts.TypeChecker, located: LocatedDeclarationType, rootDir: string): readonly ReferenceLocationType[] => {
	const symbol = checker.getSymbolAtLocation(located.nameNode);
	const definitions: ReferenceLocationType[] = [];

	for (const declaration of symbol?.declarations ?? []) {
		const nameNode = candidateNameNode(declaration);

		if (nameNode === undefined) {
			continue;
		}

		const sourceFile = declaration.getSourceFile();
		const relativePath = toLocationPath(rootDir, sourceFile.fileName);

		if (relativePath === null) {
			continue;
		}

		definitions.push({
			path: relativePath,
			startOffset: nameNode.getStart(sourceFile),
			endOffset: nameNode.end,
			role: 'definition',
		});
	}

	return definitions;
};

const symbolIdentity = (checker: ts.TypeChecker, symbol: ts.Symbol): string => {
	const seen = new Set<ts.Symbol>();
	let current = symbol;

	while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
		seen.add(current);
		current = checker.getAliasedSymbol(current);
	}

	const declarations = current.declarations ?? [];

	if (declarations.length > 0) {
		return declarations
			.map((declaration) => `${declaration.getSourceFile().fileName}:${String(declaration.getStart())}:${String(declaration.kind)}`)
			.sort((left, right) => left.localeCompare(right))
			.join('|');
	}

	return checker.getFullyQualifiedName(current);
};

const collectGroupLocations = (
	input: Readonly<{
		config: ConfigType;
		checker: ts.TypeChecker;
		constructs: ReferenceConstructIndexType;
		group: ts.ReferencedSymbol;
		authoredPaths: ReadonlySet<string>;
		definitions: ReadonlySet<string>;
		testedIdentity: string;
		locations: ReferenceLocationType[];
	}>,
): void => {
	const add = (fileName: string, span: ts.TextSpan): void => {
		const relativePath = toLocationPath(input.config.rootDir, fileName);

		if (relativePath === null || !input.authoredPaths.has(relativePath)) {
			return;
		}

		const location = {
			path: relativePath,
			startOffset: span.start,
			endOffset: span.start + span.length,
			role: 'definition' as const,
		};

		if (input.definitions.has(referenceLocationKey(location))) {
			return;
		}

		const node = input.constructs.identifierAt(relativePath, span.start, span.start + span.length);
		const resolved = node === undefined ? undefined : resolveOccurrenceSymbol(input.checker, node);

		// The language service groups related symbols, such as overrides and
		// destructuring initializers, with the symbol under test. Keep only
		// locations that actually resolve to that symbol.
		if (resolved === undefined || symbolIdentity(input.checker, resolved) !== input.testedIdentity) {
			return;
		}

		input.locations.push({...location, role: 'reference'});
	};

	add(input.group.definition.fileName, input.group.definition.textSpan);

	for (const reference of input.group.references) {
		add(reference.fileName, reference.textSpan);
	}
};

/**
 * Resolves the expected occurrence set for one indexed symbol.
 *
 * Canonical declarations are seeded directly. Language-service locations are
 * retained only when their resolved symbol identity matches the symbol under
 * test, which removes language-service grouping of overrides and destructuring
 * initializers without hiding genuine index gaps.
 *
 * @param input - Symbol, program services, and authored file set.
 * @returns Expected occurrences, or an explicit skip reason.
 */
export const lookupReferences = (
	input: Readonly<{
		config: ConfigType;
		checker: ts.TypeChecker;
		service: ts.LanguageService;
		constructs: ReferenceConstructIndexType;
		symbol: IndexedSymbolType;
		located: LocatedDeclarationType;
		authoredPaths: ReadonlySet<string>;
	}>,
): ReferenceLookupType => {
	if (!input.authoredPaths.has(input.symbol.path)) {
		return {skip: 'definition_outside_authored_files'};
	}

	const testedSymbol = ts.isIdentifier(input.located.nameNode)
		? resolveOccurrenceSymbol(input.checker, input.located.nameNode)
		: input.checker.getSymbolAtLocation(input.located.nameNode);

	if (testedSymbol === undefined) {
		return {skip: 'reference_lookup_failed'};
	}

	const definitions = canonicalDefinitions(input.checker, input.located, input.config.rootDir).filter((definition) => input.authoredPaths.has(definition.path));
	const definitionKeys = new Set(definitions.map((definition) => referenceLocationKey(definition)));
	const sourceFile = input.located.nameNode.getSourceFile();
	const groups = input.service.findReferences(sourceFile.fileName, input.located.nameNode.getStart(sourceFile));

	if (groups === undefined || groups.length === 0) {
		return {skip: 'reference_lookup_failed'};
	}

	const locations: ReferenceLocationType[] = [...definitions];
	const testedIdentity = symbolIdentity(input.checker, testedSymbol);

	for (const group of groups) {
		collectGroupLocations({
			config: input.config,
			checker: input.checker,
			constructs: input.constructs,
			group,
			authoredPaths: input.authoredPaths,
			definitions: definitionKeys,
			testedIdentity,
			locations,
		});
	}

	if (!locations.some((location) => location.role === 'definition')) {
		return {skip: 'definition_outside_authored_files'};
	}

	return {locations};
};
