import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {z} from 'zod';
import {type ConfigType} from '../../config/config.ts';
import {type ExtractedFactSetType} from '../../facts/index.ts';
import {type FinalizedFactSetType} from '../../facts/types.ts';
import {loadTypeScriptProject} from '../../../adapters/typescript/loadProject.ts';
import {type P1ReportType, type P2ReportType, type P3ReportType} from './types.ts';
import {countUnionIntersection} from './unionIntersection.ts';
import {runProjectionPrototype} from './projectionPrototype.ts';
import {type ProjectionBudgetType} from './projectionModel.ts';
import {compareReachabilityTruth} from './reachabilityTruth.ts';

const SourceMapSchema = z.object({sources: z.array(z.string())});

type PublishedRootType = Readonly<{path: string; name: string}>;

type P1AccumulatorType = {
	emittedFiles: number;
	declarationMapFiles: number;
	emitErrors: number;
	emittedModules: number;
	mappedModules: number;
	emittedExports: number;
	missingPublishedRoots: number;
	extraPublishedRoots: number;
};

type P2AccumulatorType = {
	modules: number;
	namedExternalAliases: number;
	namespaceExternalAliases: number;
	defaultExternalAliases: number;
	externalStars: number;
	commonJsModules: number;
	exportEqualsModules: number;
	exportEqualsIdentifierNames: number;
	exportEqualsExpressions: number;
	missingPublishedAliases: number;
	missingPublishedAliasesByKind: Record<string, number>;
};

const posixRelative = (rootDir: string, filePath: string): string | null => {
	const relative = path.relative(rootDir, filePath).split(path.sep).join('/');

	return relative.length === 0 || relative.startsWith('../') || path.isAbsolute(relative) ? null : relative;
};

const publishedRootsOf = (finalized: FinalizedFactSetType): readonly PublishedRootType[] => {
	const publishedBindingIds = new Set(finalized.bindingContexts.filter((context) => context.exposure === 'published').map((context) => context.bindingId));
	const roots: PublishedRootType[] = [];

	for (const binding of finalized.bindings) {
		if (!publishedBindingIds.has(binding.bindingId) || binding.segments.length !== 2) {
			continue;
		}

		const [scope, member] = binding.segments;

		if (scope?.[0] === 'module' && typeof scope[1] === 'string' && member?.[0] === 'member' && typeof member[1] === 'string') {
			roots.push({path: scope[1], name: member[1]});
		}
	}

	return roots;
};

const publishedRootsByPath = (finalized: FinalizedFactSetType): ReadonlyMap<string, ReadonlySet<string>> => {
	const byPath = new Map<string, Set<string>>();

	for (const root of publishedRootsOf(finalized)) {
		const names = byPath.get(root.path) ?? new Set<string>();
		names.add(root.name);
		byPath.set(root.path, names);
	}

	return byPath;
};

const moduleExportsOf = (checker: ts.TypeChecker, sourceFile: ts.SourceFile): readonly string[] => {
	const moduleSymbol = checker.getSymbolAtLocation(sourceFile);

	return moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName());
};

const sourcePathOfDeclarationMap = (mapPath: string, rootDir: string): string | null => {
	try {
		const raw: unknown = JSON.parse(readFileSync(mapPath, 'utf8'));
		const parsed = SourceMapSchema.safeParse(raw);

		if (!parsed.success || parsed.data.sources.length === 0) {
			return null;
		}

		const [source] = parsed.data.sources;

		return source === undefined ? null : posixRelative(rootDir, path.resolve(path.dirname(mapPath), source));
	} catch {
		return null;
	}
};

const emitDeclarations = (
	config: ConfigType,
	context: ConfigType['projects'][number],
	outputDirectory: string,
	authoredFiles: readonly string[],
): Readonly<{emittedFiles: readonly string[]; declarationMapFiles: readonly string[]; emitErrors: number}> => {
	const project = loadTypeScriptProject(config, context.projectFilePath);
	const options: ts.CompilerOptions = {
		...project.program.getCompilerOptions(),
		outDir: outputDirectory,
		allowJs: true,
		declaration: true,
		emitDeclarationOnly: true,
		declarationMap: true,
		incremental: false,
		composite: false,
		noEmit: false,
		noEmitOnError: false,
	};
	const rootNames = [...new Set([...project.program.getRootFileNames(), ...authoredFiles])];
	const program = ts.createProgram({rootNames, options});
	const emit = program.emit(
		undefined,
		(fileName, text) => {
			ts.sys.writeFile(fileName, text);
		},
		undefined,
		true,
	);
	const emittedFiles = ts.sys.readDirectory(outputDirectory, ['.d.ts', '.d.mts', '.d.cts']).sort();
	const declarationMapFiles = ts.sys.readDirectory(outputDirectory, ['.d.ts.map', '.d.mts.map', '.d.cts.map']).sort();
	const emitErrors = emit.diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length;

	return {emittedFiles, declarationMapFiles, emitErrors};
};

const compareEmittedFile = (
	checker: ts.TypeChecker,
	sourceFile: ts.SourceFile,
	rootDir: string,
	publishedByPath: ReadonlyMap<string, ReadonlySet<string>>,
): Readonly<{emittedExports: number; mapped: boolean; missing: number; extra: number}> => {
	const sourcePath = sourcePathOfDeclarationMap(`${sourceFile.fileName}.map`, rootDir);
	const names = moduleExportsOf(checker, sourceFile);

	if (sourcePath === null) {
		return {emittedExports: names.length, mapped: false, missing: 0, extra: 0};
	}

	const publishedNames = publishedByPath.get(sourcePath) ?? new Set<string>();
	const truthNames = new Set(names);
	const missing = [...truthNames].filter((name) => !publishedNames.has(name)).length;
	const extra = [...publishedNames].filter((name) => !truthNames.has(name)).length;

	return {emittedExports: names.length, mapped: true, missing, extra};
};

const addP1Context = (
	accumulator: P1AccumulatorType,
	input: Readonly<{
		config: ConfigType;
		context: ConfigType['projects'][number];
		index: number;
		directory: string;
		authoredFiles: readonly string[];
		publishedByPath: ReadonlyMap<string, ReadonlySet<string>>;
	}>,
): void => {
	const contextOutput = path.join(input.directory, `context-${String(input.index)}`);
	const emitted = emitDeclarations(input.config, input.context, contextOutput, input.authoredFiles);

	accumulator.emittedFiles += emitted.emittedFiles.length;
	accumulator.declarationMapFiles += emitted.declarationMapFiles.length;
	accumulator.emitErrors += emitted.emitErrors;

	if (emitted.emittedFiles.length === 0) {
		return;
	}

	const program = ts.createProgram({rootNames: emitted.emittedFiles, options: {skipLibCheck: true, noEmit: true, allowJs: true}});
	const checker = program.getTypeChecker();
	const emittedPaths = new Set(emitted.emittedFiles);

	for (const sourceFile of program.getSourceFiles()) {
		if (!emittedPaths.has(sourceFile.fileName) || !sourceFile.isDeclarationFile) {
			continue;
		}

		const compared = compareEmittedFile(checker, sourceFile, input.config.rootDir, input.publishedByPath);
		accumulator.emittedModules += 1;
		accumulator.emittedExports += compared.emittedExports;

		if (compared.mapped) {
			accumulator.mappedModules += 1;
			accumulator.missingPublishedRoots += compared.missing;
			accumulator.extraPublishedRoots += compared.extra;
		}
	}
};

const p1Of = (config: ConfigType, facts: ExtractedFactSetType, finalized: FinalizedFactSetType): P1ReportType => {
	const directory = mkdtempSync(path.join(tmpdir(), 'codeindex-publication-p1-'));
	const publishedByPath = publishedRootsByPath(finalized);
	const accumulator: P1AccumulatorType = {
		emittedFiles: 0,
		declarationMapFiles: 0,
		emitErrors: 0,
		emittedModules: 0,
		mappedModules: 0,
		emittedExports: 0,
		missingPublishedRoots: 0,
		extraPublishedRoots: 0,
	};

	try {
		const authoredFiles = facts.files.map((file) => file.absolutePath);

		for (const [index, context] of config.projects.entries()) {
			addP1Context(accumulator, {config, context, index, directory, authoredFiles, publishedByPath});
		}
	} finally {
		rmSync(directory, {recursive: true, force: true});
	}

	const unmappedModules = accumulator.emittedModules - accumulator.mappedModules;
	const gA = accumulator.mappedModules > 0 && accumulator.missingPublishedRoots === 0 && accumulator.extraPublishedRoots === 0 ? 'passed' : 'partial';
	const gA2 = compareReachabilityTruth({config, facts, finalized});

	return {
		status: accumulator.mappedModules > 0 ? 'partial' : 'blocked',
		contexts: config.projects.length,
		emittedFiles: accumulator.emittedFiles,
		declarationMapFiles: accumulator.declarationMapFiles,
		emitErrors: accumulator.emitErrors,
		emittedModules: accumulator.emittedModules,
		mappedModules: accumulator.mappedModules,
		unmappedModules,
		emittedExports: accumulator.emittedExports,
		publishedRoots: publishedRootsOf(finalized).length,
		missingPublishedRoots: accumulator.missingPublishedRoots,
		extraPublishedRoots: accumulator.extraPublishedRoots,
		gA2TruthDeclarations: gA2.truthDeclarations,
		gA2VisibleDeclarations: gA2.visibleDeclarations,
		gA2MissingDeclarations: gA2.missingDeclarations,
		gA2ExtraDeclarations: gA2.extraDeclarations,
		gA2AmbiguousDeclarations: gA2.ambiguousDeclarations,
		gA,
		gA2: gA2.status,
		note: 'P-1 compares emitted root exports for G-A. G-A2 compares independent compiler reachability truth with visible lexical declarations.',
	};
};

const isAuthoredFile = (sourceFile: ts.SourceFile, authoredPaths: ReadonlySet<string>): boolean => authoredPaths.has(sourceFile.fileName);

const isExternalSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): boolean => {
	const target = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
	const declarations = target.declarations ?? [];

	return declarations.length > 0 && declarations.every((declaration) => !isAuthoredFile(declaration.getSourceFile(), authoredPaths));
};

const exportKind = (symbol: ts.Symbol): 'named' | 'namespace' | 'default' => {
	if (symbol.getName() === 'default') {
		return 'default';
	}

	return (symbol.flags & ts.SymbolFlags.Namespace) === 0 ? 'named' : 'namespace';
};

const sourceHasExportEquals = (sourceFile: ts.SourceFile): Readonly<{modules: boolean; identifierNames: boolean; expressions: boolean}> => {
	let modules = false;
	let identifierNames = false;
	let expressions = false;

	const visit = (node: ts.Node): void => {
		if (ts.isExportAssignment(node) && node.isExportEquals === true) {
			modules = true;

			if (ts.isIdentifier(node.expression)) {
				identifierNames = true;
			} else {
				expressions = true;
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	return {modules, identifierNames, expressions};
};

const externalStarCount = (sourceFile: ts.SourceFile, checker: ts.TypeChecker, authoredPaths: ReadonlySet<string>): number => {
	let count = 0;

	const visit = (node: ts.Node): void => {
		if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && node.exportClause === undefined) {
			const target = checker.getSymbolAtLocation(node.moduleSpecifier);

			if (target !== undefined && isExternalSymbol(checker, target, authoredPaths)) {
				count += 1;
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return count;
};

const addP2Export = (
	accumulator: P2AccumulatorType,
	input: Readonly<{
		checker: ts.TypeChecker;
		exported: ts.Symbol;
		authoredPaths: ReadonlySet<string>;
		publishedNames: ReadonlySet<string>;
	}>,
): void => {
	if (!isExternalSymbol(input.checker, input.exported, input.authoredPaths)) {
		return;
	}

	const kind = exportKind(input.exported);

	if (kind === 'named') {
		accumulator.namedExternalAliases += 1;
	} else if (kind === 'default') {
		accumulator.defaultExternalAliases += 1;
	} else {
		accumulator.namespaceExternalAliases += 1;
	}

	if (!input.publishedNames.has(input.exported.getName())) {
		accumulator.missingPublishedAliases += 1;
		accumulator.missingPublishedAliasesByKind[kind] = (accumulator.missingPublishedAliasesByKind[kind] ?? 0) + 1;
	}
};

const addP2SourceFile = (
	accumulator: P2AccumulatorType,
	input: Readonly<{
		checker: ts.TypeChecker;
		sourceFile: ts.SourceFile;
		authoredPaths: ReadonlySet<string>;
		publishedNames: ReadonlySet<string>;
	}>,
): void => {
	const {checker, sourceFile, authoredPaths, publishedNames} = input;
	const moduleSymbol = checker.getSymbolAtLocation(sourceFile);

	if (moduleSymbol !== undefined && (moduleSymbol.flags & ts.SymbolFlags.ValueModule) !== 0) {
		accumulator.modules += 1;
	}

	const exportEquals = sourceHasExportEquals(sourceFile);

	if (exportEquals.modules) {
		accumulator.exportEqualsModules += 1;
		accumulator.commonJsModules += 1;
	}

	if (exportEquals.identifierNames) {
		accumulator.exportEqualsIdentifierNames += 1;
	}

	if (exportEquals.expressions) {
		accumulator.exportEqualsExpressions += 1;
	}

	for (const exported of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
		addP2Export(accumulator, {checker, exported, authoredPaths, publishedNames});
	}

	accumulator.externalStars += externalStarCount(sourceFile, checker, authoredPaths);
};

const addP2Context = (
	accumulator: P2AccumulatorType,
	input: Readonly<{
		config: ConfigType;
		context: ConfigType['projects'][number];
		facts: ExtractedFactSetType;
		publishedByPath: ReadonlyMap<string, ReadonlySet<string>>;
	}>,
): void => {
	const authoredPaths = new Set(input.facts.files.map((file) => file.absolutePath));
	const project = loadTypeScriptProject(input.config, input.context.projectFilePath);
	const {checker} = project;
	const authoredInContext = new Set(
		project.program
			.getSourceFiles()
			.filter((sourceFile) => isAuthoredFile(sourceFile, authoredPaths))
			.map((sourceFile) => sourceFile.fileName),
	);

	for (const sourceFile of project.program.getSourceFiles()) {
		if (!isAuthoredFile(sourceFile, authoredPaths) || sourceFile.isDeclarationFile) {
			continue;
		}

		const sourcePath = input.facts.files.find((file) => file.absolutePath === sourceFile.fileName)?.path;

		if (sourcePath === undefined) {
			continue;
		}

		addP2SourceFile(accumulator, {
			checker,
			sourceFile,
			authoredPaths: authoredInContext,
			publishedNames: input.publishedByPath.get(sourcePath) ?? new Set<string>(),
		});
	}
};

const p2Of = (config: ConfigType, facts: ExtractedFactSetType, finalized: FinalizedFactSetType): P2ReportType => {
	const accumulator: P2AccumulatorType = {
		modules: 0,
		namedExternalAliases: 0,
		namespaceExternalAliases: 0,
		defaultExternalAliases: 0,
		externalStars: 0,
		commonJsModules: 0,
		exportEqualsModules: 0,
		exportEqualsIdentifierNames: 0,
		exportEqualsExpressions: 0,
		missingPublishedAliases: 0,
		missingPublishedAliasesByKind: {named: 0, namespace: 0, default: 0},
	};
	const publishedByPath = publishedRootsByPath(finalized);

	for (const context of config.projects) {
		addP2Context(accumulator, {config, context, facts, publishedByPath});
	}

	return {
		status: accumulator.modules > 0 || accumulator.exportEqualsModules > 0 ? 'measured' : 'blocked',
		modules: accumulator.modules,
		namedExternalAliases: accumulator.namedExternalAliases,
		namespaceExternalAliases: accumulator.namespaceExternalAliases,
		defaultExternalAliases: accumulator.defaultExternalAliases,
		externalStars: accumulator.externalStars,
		commonJsModules: accumulator.commonJsModules,
		exportEqualsModules: accumulator.exportEqualsModules,
		exportEqualsIdentifierNames: accumulator.exportEqualsIdentifierNames,
		exportEqualsExpressions: accumulator.exportEqualsExpressions,
		missingPublishedAliases: accumulator.missingPublishedAliases,
		missingPublishedAliasesByKind: accumulator.missingPublishedAliasesByKind,
		note: 'P-2 reports compiler export-table aliases and export= forms. Alias/default/star publication remains Phase 4 work.',
	};
};

export type TypeScriptPrototypeResultType = Readonly<{
	readonly p1: P1ReportType;
	readonly p2: P2ReportType;
	readonly p3: P3ReportType;
	readonly unionCases: number;
	readonly intersectionCases: number;
}>;

/**
 * Runs the independent TypeScript P-1, P-2, and P-3 prototypes for Phase 2.
 *
 * P-1 emits declarations into a temporary directory and compares emitted module
 * roots with preliminary published roots. P-2 reads compiler export tables for
 * external aliases, external stars, and CommonJS `export =` forms. P-3 follows
 * compiler types to count per-root surface addresses and reachability steps.
 * None of the prototypes uses production classification to construct truth.
 *
 * @param input - Resolved configuration, fact bundle, probe budget, and finalized facts.
 * @returns Prototype outcomes and M13 source-form counts.
 */
export const runTypeScriptPrototypes = (
	input: Readonly<{
		config: ConfigType;
		facts: ExtractedFactSetType;
		finalized: FinalizedFactSetType;
		budget: ProjectionBudgetType;
	}>,
): TypeScriptPrototypeResultType => {
	const sources = new Map(input.facts.files.map((file) => [file.path, readFileSync(file.absolutePath, 'utf8')]));
	const unionCounts = countUnionIntersection(sources);

	return {
		p1: p1Of(input.config, input.facts, input.finalized),
		p2: p2Of(input.config, input.facts, input.finalized),
		p3: runProjectionPrototype({config: input.config, facts: input.facts, budget: input.budget}),
		unionCases: unionCounts.unionCases,
		intersectionCases: unionCounts.intersectionCases,
	};
};
