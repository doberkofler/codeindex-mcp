import {type ConfigType, toRepositoryPath, type ProjectContextConfigType} from '../../core/config/config.ts';
import {type DiagnosticType, type IndexedOccurrenceType, type IndexedSymbolType, type ScanResultType, type SourceFileType} from '../../core/model.ts';
import {createVerifiedSourceFileRecord} from '../../core/generation/sourceFiles.ts';
import {type ExtractorBuildType, type ExtractorType} from '../types.ts';
import {extractDependencyFacts} from './extractDependencies.ts';
import {extractSymbolFacts} from './extractSymbols.ts';
import {loadTypeScriptProject, type LoadedProjectType} from './loadProject.ts';
import {
	collectConfigFiles,
	isAuthoredSourceFile,
	scanProject,
	TYPESCRIPT_EXTRACTOR_ID,
	TYPESCRIPT_EXTRACTOR_VERSION,
	TYPESCRIPT_IGNORED_SEGMENTS,
} from './scanProject.ts';

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const LIMITATIONS: readonly string[] = [
	'JavaScript indexing requires allowJs in the selected project file',
	'declaration files and generated output are resolution-only',
	'only files reachable from the configured project files are indexed',
	'compiler facts are kept per project context and are not merged across incompatible programs',
	'other languages and cross-language edges are not indexed',
	'no fuzzy search, embeddings, or full-text search',
];

const mergeProjectFiles = (config: ConfigType, scan: ScanResultType, project: LoadedProjectType): readonly SourceFileType[] => {
	const mergedFiles = new Map(scan.files.map((file) => [file.path, file]));

	for (const sourceFile of project.program.getSourceFiles()) {
		if (!isAuthoredSourceFile(sourceFile.fileName, config.rootDir)) {
			continue;
		}

		const path = toRepositoryPath(config.rootDir, sourceFile.fileName);

		if (!mergedFiles.has(path)) {
			mergedFiles.set(path, createVerifiedSourceFileRecord(sourceFile.fileName, config.rootDir, sourceFile.text));
		}
	}

	return [...mergedFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
};

const occurrenceKey = (occurrence: IndexedOccurrenceType): string =>
	[occurrence.symbolId, occurrence.path, String(occurrence.startOffset), String(occurrence.endOffset), occurrence.role].join('\u0000');

const sortedContexts = (left: readonly string[] | undefined, right: readonly string[] | undefined): readonly string[] =>
	[...new Set([...(left ?? []), ...(right ?? [])])].sort();

const mergeSymbols = (symbols: readonly IndexedSymbolType[]): readonly IndexedSymbolType[] => {
	const merged = new Map<string, IndexedSymbolType>();

	for (const symbol of symbols) {
		const existing = merged.get(symbol.id);
		const base = existing === undefined || symbol.qualifiedName < existing.qualifiedName ? symbol : existing;

		merged.set(symbol.id, {
			...base,
			contexts: sortedContexts(existing?.contexts, symbol.contexts),
		});
	}

	return [...merged.values()].sort(
		(left, right) => left.path.localeCompare(right.path) || left.startOffset - right.startOffset || left.id.localeCompare(right.id),
	);
};

const mergeOccurrences = (occurrences: readonly IndexedOccurrenceType[]): readonly IndexedOccurrenceType[] => {
	const merged = new Map<string, IndexedOccurrenceType>();

	for (const occurrence of occurrences) {
		const key = occurrenceKey(occurrence);
		const existing = merged.get(key);

		merged.set(key, {
			...(existing ?? occurrence),
			contexts: sortedContexts(existing?.contexts, occurrence.contexts),
		});
	}

	return [...merged.values()].sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.startOffset - right.startOffset ||
			left.symbolId.localeCompare(right.symbolId) ||
			left.role.localeCompare(right.role),
	);
};

const diagnosticKey = (diagnostic: DiagnosticType): string =>
	[
		diagnostic.category,
		String(diagnostic.code),
		diagnostic.message,
		diagnostic.path ?? '',
		String(diagnostic.startLine ?? 0),
		String(diagnostic.startColumn ?? 0),
	].join('\u0000');

const mergeDiagnostics = (contexts: readonly ContextBuildType[]): readonly DiagnosticType[] => {
	const merged = new Map<string, DiagnosticType>();

	for (const context of contexts) {
		for (const diagnostic of [...context.project.diagnostics, ...context.facts.diagnostics]) {
			merged.set(diagnosticKey(diagnostic), diagnostic);
		}
	}

	return [...merged.values()];
};

const mergeContextFiles = (contexts: readonly ContextBuildType[]): readonly SourceFileType[] => {
	const merged = new Map<string, SourceFileType>();

	for (const context of contexts) {
		for (const file of context.files) {
			merged.set(file.path, file);
		}
	}

	return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
};

type LoadedContextType = Readonly<{
	readonly config: ProjectContextConfigType;
	readonly project: LoadedProjectType;
	readonly files: readonly SourceFileType[];
}>;

type ContextBuildType = LoadedContextType &
	Readonly<{
		readonly facts: ReturnType<typeof extractSymbolFacts>;
		readonly dependencies: ReturnType<typeof extractDependencyFacts>;
	}>;

const loadContext = (config: ConfigType, scan: ScanResultType, context: ProjectContextConfigType): LoadedContextType => {
	const project = loadTypeScriptProject(config, context.projectFilePath);

	return {config: context, project, files: mergeProjectFiles(config, scan, project)};
};

const extractContext = (config: ConfigType, context: LoadedContextType): ContextBuildType => ({
	...context,
	facts: extractSymbolFacts({
		project: context.project,
		files: context.files,
		projectId: config.projectId,
		rootDir: config.rootDir,
		context: context.config.name,
	}),
	dependencies: extractDependencyFacts({
		project: context.project,
		files: context.files,
		projectId: config.projectId,
		rootDir: config.rootDir,
		context: context.config.name,
	}),
});

const build = (config: ConfigType, scan: ScanResultType): ExtractorBuildType => {
	const compilerStartedAt = performance.now();
	const loaded = config.projects.map((context) => loadContext(config, scan, context));
	const compilerMs = Math.round(performance.now() - compilerStartedAt);
	const extractionStartedAt = performance.now();
	const contexts = loaded.map((context) => extractContext(config, context));
	const symbols = mergeSymbols(contexts.flatMap((context) => context.facts.symbols));
	const occurrences = mergeOccurrences(contexts.flatMap((context) => context.facts.occurrences));
	const dependencies = {
		edges: contexts.flatMap((context) => context.dependencies.edges),
		bindings: contexts.flatMap((context) => context.dependencies.bindings),
	};
	const extractionMs = Math.round(performance.now() - extractionStartedAt);

	return {
		files: mergeContextFiles(contexts),
		symbols,
		occurrences,
		dependencies,
		diagnostics: mergeDiagnostics(contexts),
		compilerMs,
		extractionMs,
	};
};

/**
 * TypeScript and JavaScript extractor backed by the TypeScript compiler API.
 *
 * The adapter owns every compiler object and emits only serializable facts.
 */
export const typeScriptExtractor: ExtractorType = {
	id: TYPESCRIPT_EXTRACTOR_ID,
	version: TYPESCRIPT_EXTRACTOR_VERSION,
	displayName: 'TypeScript / JavaScript',
	sourceExtensions: SOURCE_EXTENSIONS,
	ignoredSegments: TYPESCRIPT_IGNORED_SEGMENTS,
	limitations: LIMITATIONS,
	scan: scanProject,
	build,
	configFiles: (config) => [...new Set(config.projects.flatMap((project) => collectConfigFiles(project.projectFilePath, config.rootDir)))],
	isSourceFile: isAuthoredSourceFile,
};
