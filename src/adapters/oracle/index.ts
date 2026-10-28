import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {type ConfigType} from '../../core/config/config.ts';
import {
	type AdapterStatType,
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
import {type ExtractorArtifactCacheType, type ExtractorBuildType, type ExtractorFactReuseInputType, type ExtractorType} from '../types.ts';
import {extractOracleDependencies} from './extractDependencies.ts';
import {extractOracleSymbols, type OracleContextSymbolsType, type OracleParsedFileType} from './extractSymbols.ts';
import {mergeAdapterStats, oraclePublicationStats} from './publicationStats.ts';
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

/**
 * Artifact kind prefix for the digest of one file's parser output.
 *
 * The digest proves that a changed file produced identical parser facts, which
 * lets the published facts survive a content-only edit. The context suffix keeps
 * per-context parse results (different default schemas) distinct.
 */
const PARSE_DIGEST_KIND = 'oracle-parse-digest';

const parseDigestOf = (parse: OracleParsedFileType['parse']): string => createHash('sha256').update(JSON.stringify(parse)).digest('hex');

const parseDigestKindOf = (context: string): string => `${PARSE_DIGEST_KIND}:${context}`;

const LIMITATIONS: readonly string[] = [
	'Oracle 19c static source only; no live database or catalogue indexing',
	'package specifications, package bodies, and standalone procedures/functions are indexed',
	'object types, triggers, views, tables, columns, synonyms, and database links are not indexed',
	'dynamic SQL, wrapped source, and conditional-compilation branches are outside O1 scope',
	'table and SQL object lineage is deferred; only package dependencies are emitted',
	'no cross-language edges, embeddings, or full-text search',
];

const DISCOVERY_TEXT =
	'The selected Oracle extractor indexes packages, procedures, and functions from package specifications (.pks), package bodies (.pkb), and configured standalone SQL / PL/SQL files. Search with natural qualified names such as LAS_SQL_JPos.reorderPos.';

type ContextResultType = Readonly<{
	symbols: OracleContextSymbolsType;
	occurrences: readonly IndexedOccurrenceType[];
	edges: readonly IndexedDependencyEdgeType[];
	diagnostics: readonly DiagnosticType[];
	adapterStats: readonly AdapterStatType[];
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
	input: Readonly<{
		config: ConfigType;
		context: ConfigType['projects'][number];
		scan: ScanResultType;
		parser: OracleParserBindingType['parser'];
		cache?: ExtractorArtifactCacheType;
	}>,
): ContextResultType => {
	const {config, context, scan, parser, cache} = input;
	const startedAt = performance.now();
	const manifest = readOracleManifest(context.projectFilePath);
	const parsed: OracleParsedFileType[] = [];
	const diagnostics: DiagnosticType[] = [];
	const sources = new Map<string, string>();
	const parseStartedAt = performance.now();
	const digestKind = parseDigestKindOf(context.name);

	for (const file of scan.files.filter((candidate) => matchesOracleManifest(candidate.path, manifest.manifest))) {
		const source = readFileSync(file.absolutePath, 'utf8');
		const parse = parser({source, path: file.path, defaultSchema: manifest.canonicalSchema});
		const artifact = {contentSha256: file.sha256, kind: digestKind};

		if (cache !== undefined && !cache.has(artifact)) {
			cache.write({...artifact, payload: parseDigestOf(parse)});
		}

		parsed.push({path: file.path, parse});
		sources.set(file.path, source);
		diagnostics.push(...parse.diagnostics);
	}

	const readParseMs = Math.round(performance.now() - parseStartedAt);
	const symbolsStartedAt = performance.now();
	const symbols = extractOracleSymbols({projectId: config.projectId, context: context.name, files: parsed, storedOnly: true});
	const symbolsMs = Math.round(performance.now() - symbolsStartedAt);
	const referencesStartedAt = performance.now();
	const references = resolveOracleReferences({
		context: context.name,
		defaultSchema: manifest.canonicalSchema,
		files: symbols.analyses,
		packages: symbols.packages,
		storedOnly: true,
	});
	const referencesMs = Math.round(performance.now() - referencesStartedAt);
	const dependenciesStartedAt = performance.now();
	const dependencies = extractOracleDependencies({
		projectId: config.projectId,
		context: context.name,
		defaultSchema: manifest.canonicalSchema,
		files: symbols.analyses,
		packages: symbols.packages,
	});
	const dependenciesMs = Math.round(performance.now() - dependenciesStartedAt);
	debug('oracle context phases', {context: context.name, readParseMs, symbolsMs, referencesMs, dependenciesMs});
	const contextDiagnostics = [...diagnostics, ...symbols.diagnostics, ...references.diagnostics];

	return {
		symbols,
		occurrences: [...symbols.occurrences, ...references.occurrences],
		edges: dependencies.edges,
		diagnostics: contextDiagnostics,
		adapterStats: oraclePublicationStats({analyses: symbols.analyses, sources, diagnostics: contextDiagnostics}).stats,
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

const build = (config: ConfigType, scan: ScanResultType, parser: OracleParserBindingType['parser'], cache?: ExtractorArtifactCacheType): ExtractorBuildType => {
	const startedAt = performance.now();
	const contexts = config.projects.map((context) =>
		parseContext({
			config,
			context,
			scan,
			parser,
			...(cache === undefined ? {} : {cache}),
		}),
	);
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
		adapterStats: mergeAdapterStats(contexts.map((context) => context.adapterStats)),
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
/**
 * Proves that persisted Oracle facts still describe the current sources.
 *
 * A file whose parser output is unchanged contributes identical symbols,
 * occurrences, dependencies, and diagnostics. Cross-file resolution can only
 * differ when some parser output differs, so every changed file is re-parsed and
 * compared against the digest captured when its facts were published. Any doubt
 * returns false and forces a full extraction.
 *
 * @param input - Scan, published manifest, artifact reader, and parser binding.
 * @returns True when every changed file produces its published parser output.
 */
const canReusePublishedFacts = (input: ExtractorFactReuseInputType, binding: OracleParserBindingType): boolean => {
	const previous = new Map(input.publishedFiles.map((file) => [file.path, file.sha256]));

	if (previous.size !== input.scan.files.length) {
		return false;
	}

	for (const file of input.scan.files) {
		const previousSha = previous.get(file.path);

		if (previousSha === undefined) {
			return false;
		}

		if (previousSha === file.sha256) {
			continue;
		}

		let matched = false;

		for (const context of input.config.projects) {
			const manifest = readOracleManifest(context.projectFilePath);

			if (!matchesOracleManifest(file.path, manifest.manifest)) {
				continue;
			}

			matched = true;
			const kind = parseDigestKindOf(context.name);
			const artifact = {contentSha256: previousSha, kind};
			const stored = input.read(artifact);

			if (stored === null) {
				return false;
			}

			const source = readFileSync(file.absolutePath, 'utf8');
			const parse = binding.parser({source, path: file.path, defaultSchema: manifest.canonicalSchema});
			const digest = parseDigestOf(parse);

			if (digest !== stored) {
				return false;
			}

			input.write({contentSha256: file.sha256, kind, payload: digest});
		}

		if (!matched) {
			return false;
		}
	}

	return true;
};

export const createOracleExtractor = (binding: OracleParserBindingType): ExtractorType => ({
	id: ORACLE_EXTRACTOR_ID,
	version: ORACLE_EXTRACTOR_VERSION,
	displayName: 'Oracle 19c SQL / PL/SQL',
	discoveryText: DISCOVERY_TEXT,
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
	build: (config, scan, cache) => {
		assertOracleParserBinding(config, binding);
		return build(config, scan, binding.parser, cache);
	},
	canReusePublishedFacts: (input) => {
		assertOracleParserBinding(input.config, binding);
		return canReusePublishedFacts(input, binding);
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
