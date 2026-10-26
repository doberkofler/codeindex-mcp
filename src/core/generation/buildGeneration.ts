import {randomUUID} from 'node:crypto';
import {extractorFor} from '../../adapters/registry.ts';
import {type ExtractorArtifactCacheType, type ExtractorBuildType, type ExtractorType} from '../../adapters/types.ts';
import {type ConfigType} from '../config/config.ts';
import {PUBLICATION_SURFACE_BINDINGS_PER_ROOT, finalizeFacts, type FinalizedFactSetType} from '../facts/index.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildReportType, type BuildStagesType, type ExtractionResultType, type GenerationRowType, type ScanResultType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {artifactKeyOf, createExtractorCache, persistArtifactCaches} from './buildArtifacts.ts';
import {computeSourceHash} from './sourceFiles.ts';

const debug = debugFor('build');

type BuildInputType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	logger: LoggerType;
	scan?: ScanResultType;
	force?: boolean;
	ownerId?: string;
	/** Qualification-only adapter override; production resolves from the registry. */
	extractor?: ExtractorType;
}>;

type BuildCountsType = Readonly<{
	files: number;
	symbols: number;
	occurrences: number;
	dependencyEdges: number;
	dependencyBindings: number;
	diagnostics: number;
}>;

type CommitContextType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	extractor: ExtractorType;
	logger: LoggerType;
	scan: ScanResultType;
	generationId: string;
	mode: 'insert' | 'revise';
	startedAt: number;
	extractorOverride: ExtractorType | undefined;
	ownerId: string | undefined;
}>;

type ReuseProbeInputType = Readonly<{
	extractor: ExtractorType;
	config: ConfigType;
	scan: ScanResultType;
	database: IndexDatabase;
	cache: ExtractorArtifactCacheType;
	publishedFiles: readonly Readonly<{path: string; sha256: string}>[];
	published: GenerationRowType | null;
	force: boolean | undefined;
}>;

const createReport = (
	input: Readonly<{
		generationId: string;
		revision: number;
		reused: boolean;
		durationMs: number;
		counts: BuildCountsType;
		stages: BuildStagesType | null;
	}>,
): BuildReportType => ({
	generationId: input.generationId,
	revision: input.revision,
	state: 'published',
	reused: input.reused,
	durationMs: input.durationMs,
	fileCount: input.counts.files,
	symbolCount: input.counts.symbols,
	occurrenceCount: input.counts.occurrences,
	dependencyEdgeCount: input.counts.dependencyEdges,
	dependencyBindingCount: input.counts.dependencyBindings,
	diagnosticCount: input.counts.diagnostics,
	stages: input.stages,
});

const findReusableGeneration = (database: IndexDatabase, scan: ScanResultType, force: boolean | undefined): GenerationRowType | null =>
	force === true ? null : database.findReusableGeneration(scan.sourceHash, scan.configHash);

const finalizePublication = (facts: ExtractorBuildType, extractorId: string | null): FinalizedFactSetType => {
	const publication = finalizeFacts(facts, {
		mode: 'enforce',
		maxBindingsPerRoot: PUBLICATION_SURFACE_BINDINGS_PER_ROOT,
		...(extractorId === null ? {} : {extractorId}),
	});

	debug('publication facts finalized', publication.stats);
	return publication;
};

/**
 * Reports whether the published generation still guarantees the facts of this scan.
 *
 * The adapter owns the proof: it must show that every changed file produces the
 * same parser output as the version whose facts are already published.
 *
 * @param input - Extractor, scan, published manifest, database, and force flag.
 * @returns True when persisted facts can be reused without extraction.
 */
const factsAreReusable = (input: ReuseProbeInputType): boolean => {
	if (input.published === null || input.force === true || input.extractor.canReusePublishedFacts === undefined) {
		return false;
	}

	const startedAt = performance.now();
	const reusable = input.extractor.canReusePublishedFacts({
		config: input.config,
		scan: input.scan,
		publishedFiles: input.publishedFiles,
		read: (artifact) => input.database.getExtractionArtifact(artifactKeyOf(input.scan, artifact)),
		write: (artifact) => {
			input.cache.write(artifact);
		},
	});
	debug('fact reuse probe', {reusable, durationMs: Math.round(performance.now() - startedAt)});
	return reusable;
};

const logBuild = (
	input: Readonly<{
		logger: LoggerType;
		generationId: string;
		revision: number;
		durationMs: number;
		reusedFacts: boolean;
		counts: BuildCountsType;
		stages: BuildStagesType;
	}>,
): void => {
	input.logger.info('index_built', {
		generationId: input.generationId,
		revision: input.revision,
		durationMs: input.durationMs,
		files: input.counts.files,
		symbols: input.counts.symbols,
		occurrences: input.counts.occurrences,
		dependencyEdges: input.counts.dependencyEdges,
		dependencyBindings: input.counts.dependencyBindings,
		diagnostics: input.counts.diagnostics,
		reusedFacts: input.reusedFacts,
		stages: input.stages,
	});
};

const persistCachesSafely = (action: () => void): void => {
	try {
		action();
	} catch (error) {
		// Artifacts are derived and rebuildable; losing them costs work, never correctness.
		debug('artifact cache persistence failed', {message: error instanceof Error ? error.message : String(error)});
	}
};

const commitReuse = (context: CommitContextType): BuildReportType => {
	const commit = context.database.commitGeneration({
		mode: context.mode,
		reuseFacts: true,
		generationId: context.generationId,
		files: context.scan.files,
		projects: context.scan.projects,
		sourceHash: context.scan.sourceHash,
		configHash: context.scan.configHash,
		stages: {scanMs: context.scan.scanMs, compilerMs: 0, extractionMs: 0},
		...(context.ownerId === undefined ? {} : {ownerId: context.ownerId}),
	});
	const durationMs = Math.round(performance.now() - context.startedAt);

	logBuild({
		logger: context.logger,
		generationId: context.generationId,
		revision: commit.revision,
		durationMs,
		reusedFacts: true,
		counts: commit.counts,
		stages: commit.stages,
	});

	return createReport({generationId: context.generationId, revision: commit.revision, reused: false, durationMs, counts: commit.counts, stages: commit.stages});
};

const commitExtraction = (context: CommitContextType): BuildReportType => {
	const cache = createExtractorCache(context.database, context.scan);
	const extracted = context.extractor.build(context.config, context.scan, cache.cache);
	// Qualification-only parser overrides are not production builds; keep measured invariants report-only there.
	const finalized = finalizePublication(extracted, context.extractorOverride === undefined ? context.scan.extractorId : null);
	const artifactFacts: ExtractionResultType = {
		symbols: extracted.symbols,
		occurrences: extracted.occurrences,
		diagnostics: extracted.diagnostics,
		diagnosticCount: extracted.diagnostics.length,
	};
	const commit = context.database.commitGeneration({
		mode: context.mode,
		reuseFacts: false,
		generationId: context.generationId,
		language: context.scan.extractorId,
		files: extracted.files,
		projects: context.scan.projects,
		facts: finalized,
		dependencies: extracted.dependencies,
		diagnostics: extracted.diagnostics,
		sourceHash: computeSourceHash(extracted.files),
		configHash: context.scan.configHash,
		stages: {
			scanMs: context.scan.scanMs,
			compilerMs: extracted.compilerMs,
			extractionMs: extracted.extractionMs,
		},
		...(context.ownerId === undefined ? {} : {ownerId: context.ownerId}),
	});
	persistCachesSafely(() => {
		cache.flush();
		persistArtifactCaches({
			database: context.database,
			generationId: context.generationId,
			files: extracted.files,
			facts: artifactFacts,
			dependencies: extracted.dependencies,
			contextHash: context.scan.artifactContextHash ?? context.scan.configHash,
			extractorId: context.scan.extractorId,
			extractorVersion: context.scan.extractorVersion,
		});
	});
	const durationMs = Math.round(performance.now() - context.startedAt);

	logBuild({
		logger: context.logger,
		generationId: context.generationId,
		revision: commit.revision,
		durationMs,
		reusedFacts: false,
		counts: commit.counts,
		stages: commit.stages,
	});

	return createReport({generationId: context.generationId, revision: commit.revision, reused: false, durationMs, counts: commit.counts, stages: commit.stages});
};

const reusedReport = (reusable: GenerationRowType, startedAt: number): BuildReportType =>
	createReport({
		generationId: reusable.id,
		revision: reusable.revision,
		reused: true,
		durationMs: Math.round(performance.now() - startedAt),
		counts: {
			files: reusable.fileCount,
			symbols: reusable.symbolCount,
			occurrences: reusable.occurrenceCount,
			dependencyEdges: reusable.dependencyEdgeCount,
			dependencyBindings: reusable.dependencyBindingCount,
			diagnostics: reusable.diagnosticCount,
		},
		stages: null,
	});

const prepareBuild = (
	input: BuildInputType,
): Readonly<{
	published: GenerationRowType | null;
	publishedFiles: readonly Readonly<{path: string; sha256: string}>[];
	extractor: ExtractorType;
	scan: ScanResultType;
}> => {
	const published = input.database.getPublishedGeneration();
	const publishedFiles = published === null ? [] : input.database.listFiles(published.id);
	const extractor = input.extractor ?? extractorFor(input.config.extractorId);
	const scan =
		input.scan ??
		extractor.scan(
			input.config,
			publishedFiles.map((file) => file.path),
		);

	return {published, publishedFiles, extractor, scan};
};

const beginGeneration = (
	input: BuildInputType,
	published: GenerationRowType | null,
	scan: ScanResultType,
): Readonly<{generationId: string; mode: 'insert' | 'revise'}> => {
	if (published !== null) {
		return {generationId: published.id, mode: 'revise'};
	}

	const generationId = randomUUID();
	input.database.createGeneration({
		id: generationId,
		extractorId: scan.extractorId,
		extractorVersion: scan.extractorVersion,
		compilerVersion: scan.compilerVersion,
		sourceHash: scan.sourceHash,
		configHash: scan.configHash,
	});

	return {generationId, mode: 'insert'};
};

/**
 * Builds and atomically publishes one complete index generation.
 *
 * The published generation identifier is stable. When the extractor proves that
 * every changed file produces the same parser output, only version metadata is
 * revised; otherwise the new fact set replaces changed path groups. A failed
 * build leaves the previous published revision serving queries.
 *
 * @param input - Resolved configuration, database, logger, and optional scan or forced rebuild.
 * @returns The published or reused generation report.
 * @throws {@link Error} When scanning, loading, extraction, or publication fails.
 */
export const buildGeneration = (input: BuildInputType): BuildReportType => {
	const startedAt = performance.now();
	const {published, publishedFiles, extractor, scan} = prepareBuild(input);
	const reusable = findReusableGeneration(input.database, scan, input.force);
	debug('build start', {
		force: input.force === true,
		scanProvided: input.scan !== undefined,
		published: published?.id ?? null,
		sourceHash: scan.sourceHash,
		configHash: scan.configHash,
		reusable: reusable?.id ?? null,
	});

	if (reusable !== null) {
		const report = reusedReport(reusable, startedAt);
		input.logger.info('index_reused', {generationId: reusable.id, revision: reusable.revision, durationMs: report.durationMs});
		return report;
	}

	const {generationId, mode} = beginGeneration(input, published, scan);
	const cache = createExtractorCache(input.database, scan);
	const reuseFacts = factsAreReusable({
		extractor,
		config: input.config,
		scan,
		database: input.database,
		cache: cache.cache,
		publishedFiles,
		published,
		force: input.force,
	});
	const context: CommitContextType = {
		config: input.config,
		database: input.database,
		extractor,
		logger: input.logger,
		scan,
		generationId,
		mode,
		startedAt,
		extractorOverride: input.extractor,
		ownerId: input.ownerId,
	};

	try {
		const report = reuseFacts ? commitReuse(context) : commitExtraction(context);

		if (reuseFacts) {
			persistCachesSafely(() => {
				cache.flush();
			});
		}

		return report;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		debug('build failed', {generationId, message});
		input.logger.error('index_build_failed', {generationId, message});

		if (mode === 'insert') {
			input.database.markFailed(generationId, message);
		}

		throw error;
	}
};
