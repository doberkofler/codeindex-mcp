import {readFileSync} from 'node:fs';
import {type ConfigType} from '../../core/config/config.ts';
import {
	type ExtractedBindingContextType,
	type ExtractedBindingSiteType,
	type ExtractedBindingType,
	type ExtractedPublicationFactsType,
	type ExtractedSurfaceOriginType,
} from '../../core/facts/index.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {
	type DiagnosticType,
	type IndexedDependencyEdgeType,
	type IndexedOccurrenceType,
	type IndexedSymbolType,
	type ScanResultType,
} from '../../core/model.ts';
import {type ExtractorBuildType, type ExtractorType} from '../types.ts';
import {extractOracleDependencies} from './extractDependencies.ts';
import {extractOracleSymbols, type OracleContextSymbolsType, type OracleParsedFileType} from './extractSymbols.ts';
import {DEFAULT_ORACLE_SOURCE_EXTENSIONS, matchesOracleManifest, readOracleManifest} from './manifest.ts';
import {assertOracleParserBinding, structuralOracleParserBinding, type OracleParserBindingType} from './parserBinding.ts';
import {resolveOracleReferences} from './resolveReferences.ts';
import {
	collectOracleConfigFiles,
	isOracleAuthoredSourceFile,
	ORACLE_EXTRACTOR_ID,
	ORACLE_EXTRACTOR_VERSION,
	ORACLE_IGNORED_SEGMENTS,
	scanOracleProject,
} from './scanProject.ts';

const debug = debugFor('oracle');

const LIMITATIONS: readonly string[] = [
	'Oracle 19c static source only; no live database or catalogue indexing',
	'package specifications, package bodies, and standalone procedures/functions are indexed',
	'object types, triggers, views, tables, columns, synonyms, and database links are not indexed',
	'dynamic SQL, wrapped source, and conditional-compilation branches are outside O1 scope',
	'table and SQL object lineage is deferred; only package dependencies are emitted',
	'no cross-language edges, embeddings, or full-text search',
];

type ContextResultType = Readonly<{
	symbols: OracleContextSymbolsType;
	occurrences: readonly IndexedOccurrenceType[];
	edges: readonly IndexedDependencyEdgeType[];
	diagnostics: readonly DiagnosticType[];
	parseMs: number;
}>;

const addressKey = (segments: ExtractedBindingType['segments']): string => JSON.stringify(segments);

const mergePublicationFacts = (contexts: readonly ContextResultType[]): ExtractedPublicationFactsType => {
	const bindings = new Map<string, ExtractedBindingType>();
	const contextsByName = new Map<string, ExtractedBindingContextType>();
	const sites = new Map<string, ExtractedBindingSiteType>();
	const origins = new Map<string, ExtractedSurfaceOriginType>();

	for (const context of contexts) {
		const {publication} = context.symbols;

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

const parseContext = (
	config: ConfigType,
	context: ConfigType['projects'][number],
	scan: ScanResultType,
	parser: OracleParserBindingType['parser'],
): ContextResultType => {
	const startedAt = performance.now();
	const manifest = readOracleManifest(context.projectFilePath);
	const parsed: OracleParsedFileType[] = [];
	const diagnostics: DiagnosticType[] = [];

	for (const file of scan.files.filter((candidate) => matchesOracleManifest(candidate.path, manifest.manifest))) {
		const source = readFileSync(file.absolutePath, 'utf8');
		const parse = parser({source, path: file.path, defaultSchema: manifest.canonicalSchema});

		parsed.push({path: file.path, parse});
		diagnostics.push(...parse.diagnostics);
	}

	const symbols = extractOracleSymbols({projectId: config.projectId, context: context.name, files: parsed});
	const references = resolveOracleReferences({
		context: context.name,
		defaultSchema: manifest.canonicalSchema,
		files: symbols.analyses,
		packages: symbols.packages,
	});
	const dependencies = extractOracleDependencies({
		projectId: config.projectId,
		context: context.name,
		defaultSchema: manifest.canonicalSchema,
		files: symbols.analyses,
		packages: symbols.packages,
	});

	return {
		symbols,
		occurrences: [...symbols.occurrences, ...references.occurrences],
		edges: dependencies.edges,
		diagnostics: [...diagnostics, ...symbols.diagnostics, ...references.diagnostics],
		parseMs: Math.round(performance.now() - startedAt),
	};
};

const mergeSymbols = (contexts: readonly ContextResultType[]): readonly IndexedSymbolType[] => {
	const merged = new Map<string, IndexedSymbolType>();

	for (const symbol of contexts.flatMap((context) => context.symbols.symbols)) {
		const existing = merged.get(symbol.id);
		const contextsForSymbol = [...new Set([...(existing?.contexts ?? []), ...(symbol.contexts ?? [])])].sort();

		merged.set(symbol.id, {...(existing ?? symbol), contexts: contextsForSymbol});
	}

	return [...merged.values()].sort(
		(left, right) => left.path.localeCompare(right.path) || left.startOffset - right.startOffset || left.id.localeCompare(right.id),
	);
};

const occurrenceKey = (occurrence: IndexedOccurrenceType): string =>
	[occurrence.symbolId, occurrence.path, String(occurrence.startOffset), occurrence.role].join('\u0000');

const mergeOccurrences = (contexts: readonly ContextResultType[]): readonly IndexedOccurrenceType[] => {
	const merged = new Map<string, IndexedOccurrenceType>();

	for (const occurrence of contexts.flatMap((context) => context.occurrences)) {
		const key = occurrenceKey(occurrence);
		const existing = merged.get(key);
		const occurrenceContexts = [...new Set([...(existing?.contexts ?? []), ...(occurrence.contexts ?? [])])].sort();

		merged.set(key, {...(existing ?? occurrence), contexts: occurrenceContexts});
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

const mergeDiagnostics = (contexts: readonly ContextResultType[]): readonly DiagnosticType[] => {
	const merged = new Map<string, DiagnosticType>();

	for (const diagnostic of contexts.flatMap((context) => context.diagnostics)) {
		merged.set(diagnosticKey(diagnostic), diagnostic);
	}

	return [...merged.values()];
};

const build = (config: ConfigType, scan: ScanResultType, parser: OracleParserBindingType['parser']): ExtractorBuildType => {
	const startedAt = performance.now();
	const contexts = config.projects.map((context) => parseContext(config, context, scan, parser));
	const compilerMs = contexts.reduce((total, context) => total + context.parseMs, 0);
	const extractionMs = Math.round(performance.now() - startedAt);
	const result = {
		files: scan.files,
		symbols: mergeSymbols(contexts),
		...mergePublicationFacts(contexts),
		occurrences: mergeOccurrences(contexts),
		dependencies: {
			edges: contexts
				.flatMap((context) => context.edges)
				.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.startOffset - right.startOffset || left.id.localeCompare(right.id)),
			bindings: [],
		},
		adapterStats: [],
		diagnostics: mergeDiagnostics(contexts),
		compilerMs,
		extractionMs,
	};

	debug('oracle build complete', {
		files: result.files.length,
		symbols: result.symbols.length,
		occurrences: result.occurrences.length,
		dependencies: result.dependencies.edges.length,
		diagnostics: result.diagnostics.length,
		compilerMs,
		extractionMs,
	});

	return result;
};

/**
 * Creates an Oracle extractor bound to one parser implementation.
 *
 * Production binds the structural parser. Qualification binds the ANTLR parser
 * in a separate, dynamically loaded module.
 *
 * @param binding - Parser implementation and its serializable identity.
 * @returns The adapter bound to that parser.
 */
export const createOracleExtractor = (binding: OracleParserBindingType): ExtractorType => ({
	id: ORACLE_EXTRACTOR_ID,
	version: ORACLE_EXTRACTOR_VERSION,
	displayName: 'Oracle 19c SQL / PL/SQL',
	sourceExtensions: DEFAULT_ORACLE_SOURCE_EXTENSIONS,
	sourceExtensionsFor: (config) => {
		const extensions = new Set<string>();

		for (const project of config.projects) {
			for (const extension of readOracleManifest(project.projectFilePath).manifest.extensions) {
				extensions.add(extension);
			}
		}

		return [...extensions].sort();
	},
	ignoredSegments: ORACLE_IGNORED_SEGMENTS,
	limitations: LIMITATIONS,
	scan: (config, knownPaths) => {
		assertOracleParserBinding(config, binding);
		return scanOracleProject(config, knownPaths);
	},
	build: (config, scan) => {
		assertOracleParserBinding(config, binding);
		return build(config, scan, binding.parser);
	},
	configFiles: collectOracleConfigFiles,
	isSourceFile: isOracleAuthoredSourceFile,
});

/**
 * Production Oracle 19c SQL and PL/SQL extractor.
 *
 * The adapter is static: it never opens a database connection. ANTLR lexer
 * objects stay inside per-file tokenization and only serializable facts leave.
 */
export const oracleExtractor: ExtractorType = createOracleExtractor(structuralOracleParserBinding);
