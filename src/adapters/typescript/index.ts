import {type ConfigType, toRepositoryPath, type ProjectContextConfigType} from '../../core/config/config.ts';
import {
	type ExtractedBindingContextType,
	type ExtractedBindingSiteType,
	type ExtractedBindingType,
	type ExtractedPublicationFactsType,
	type ExtractedSurfaceOriginType,
} from '../../core/facts/index.ts';
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

const dedupeDiagnostics = (diagnostics: readonly DiagnosticType[]): readonly DiagnosticType[] => {
	const merged = new Map<string, DiagnosticType>();

	for (const diagnostic of diagnostics) {
		merged.set(diagnosticKey(diagnostic), diagnostic);
	}

	return [...merged.values()];
};

const mergeDiagnostics = (contexts: readonly ExtractedContextType[]): readonly DiagnosticType[] =>
	dedupeDiagnostics(contexts.flatMap((context) => [...context.diagnostics, ...context.facts.diagnostics]));

const mergeContextFiles = (contexts: readonly ExtractedContextType[]): readonly SourceFileType[] => {
	const merged = new Map<string, SourceFileType>();

	for (const context of contexts) {
		for (const file of context.files) {
			merged.set(file.path, file);
		}
	}

	return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
};

type ExtractedContextType = Readonly<{
	readonly files: readonly SourceFileType[];
	readonly facts: ReturnType<typeof extractSymbolFacts>;
	readonly dependencies: ReturnType<typeof extractDependencyFacts>;
	readonly diagnostics: readonly DiagnosticType[];
}>;

const addressKey = (segments: ExtractedBindingType['segments']): string => JSON.stringify(segments);

const mergePublicationFacts = (contexts: readonly ExtractedContextType[]): ExtractedPublicationFactsType => {
	const bindings = new Map<string, ExtractedBindingType>();
	const contextsByName = new Map<string, ExtractedBindingContextType>();
	const sites = new Map<string, ExtractedBindingSiteType>();
	const origins = new Map<string, ExtractedSurfaceOriginType>();

	for (const context of contexts) {
		const {publication} = context.facts;

		for (const binding of publication.bindings) {
			const key = `${binding.symbolId}\u0000${addressKey(binding.segments)}`;
			bindings.set(key, binding);
		}

		for (const bindingContext of publication.bindingContexts) {
			const key = `${bindingContext.symbolId}\u0000${addressKey(bindingContext.segments)}\u0000${bindingContext.context}`;
			contextsByName.set(key, bindingContext);
		}

		for (const site of publication.bindingSites) {
			const key = `${site.symbolId}\u0000${addressKey(site.segments)}\u0000${site.kind}\u0000${site.path}\u0000${String(site.range.startOffset)}`;
			sites.set(key, site);
		}

		for (const origin of publication.surfaceOrigins) {
			const key = `${origin.symbolId}\u0000${addressKey(origin.segments)}\u0000${origin.context}`;
			origins.set(key, origin);
		}
	}

	return {
		bindings: [...bindings.values()].sort(
			(left, right) => left.symbolId.localeCompare(right.symbolId) || addressKey(left.segments).localeCompare(addressKey(right.segments)),
		),
		bindingContexts: [...contextsByName.values()].sort(
			(left, right) =>
				left.context.localeCompare(right.context) ||
				left.symbolId.localeCompare(right.symbolId) ||
				addressKey(left.segments).localeCompare(addressKey(right.segments)),
		),
		bindingSites: [...sites.values()].sort(
			(left, right) => left.path.localeCompare(right.path) || left.range.startOffset - right.range.startOffset || left.symbolId.localeCompare(right.symbolId),
		),
		surfaceOrigins: [...origins.values()].sort((left, right) => left.symbolId.localeCompare(right.symbolId) || left.context.localeCompare(right.context)),
	};
};

const extractContext = (
	config: ConfigType,
	scan: ScanResultType,
	context: ProjectContextConfigType,
): Readonly<{context: ExtractedContextType; compilerMs: number}> => {
	const {projectFilePath} = context;
	const compilerStartedAt = performance.now();
	const project = loadTypeScriptProject(config, projectFilePath);
	const files = mergeProjectFiles(config, scan, project);
	const compilerMs = Math.round(performance.now() - compilerStartedAt);
	const facts = extractSymbolFacts({
		project,
		files,
		projectId: config.projectId,
		rootDir: config.rootDir,
		context: context.name,
	});
	const dependencies = extractDependencyFacts({
		project,
		files,
		projectId: config.projectId,
		rootDir: config.rootDir,
		context: context.name,
	});

	// Only serializable facts leave this scope. The compiler program and its
	// syntax trees stay collectable while insertion and artifact persistence run.
	return {context: {files, facts, dependencies, diagnostics: project.diagnostics}, compilerMs};
};

const mergeContexts = (contexts: readonly ExtractedContextType[]): Omit<ExtractorBuildType, 'compilerMs' | 'extractionMs'> => {
	if (contexts.length === 1) {
		const [context] = contexts;

		if (context === undefined) {
			throw new Error('TypeScript extractor produced no project context');
		}

		return {
			files: context.files,
			symbols: context.facts.symbols,
			...context.facts.publication,
			occurrences: context.facts.occurrences,
			dependencies: context.dependencies,
			adapterStats: [],
			diagnostics: dedupeDiagnostics([...context.diagnostics, ...context.facts.diagnostics]),
		};
	}

	return {
		files: mergeContextFiles(contexts),
		symbols: mergeSymbols(contexts.flatMap((context) => context.facts.symbols)),
		...mergePublicationFacts(contexts),
		occurrences: mergeOccurrences(contexts.flatMap((context) => context.facts.occurrences)),
		dependencies: {
			edges: contexts.flatMap((context) => context.dependencies.edges),
			bindings: contexts.flatMap((context) => context.dependencies.bindings),
		},
		adapterStats: [],
		diagnostics: mergeDiagnostics(contexts),
	};
};

const build = (config: ConfigType, scan: ScanResultType): ExtractorBuildType => {
	const extractionStartedAt = performance.now();
	const extracted = config.projects.map((context) => extractContext(config, scan, context));
	const compilerMs = extracted.reduce((total, context) => total + context.compilerMs, 0);
	const merged = mergeContexts(extracted.map((context) => context.context));
	const extractionMs = Math.round(performance.now() - extractionStartedAt);

	return {...merged, compilerMs, extractionMs};
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
