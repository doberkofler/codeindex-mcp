import {randomUUID} from 'node:crypto';
import {type ConfigType} from '../config/config.ts';
import {extractorFor} from '../extractors/registry.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {
	type BuildReportType,
	type BuildStagesType,
	type DependencyExtractionResultType,
	type DiagnosticType,
	type ExtractionResultType,
	type GenerationRowType,
	type ScanResultType,
	type SourceFileType,
} from './model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {computeSourceHash} from './sourceFiles.ts';

const debug = debugFor('build');

type BuildInputType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	logger: LoggerType;
	scan?: ScanResultType;
	force?: boolean;
}>;

type BuildCountsType = Readonly<{
	files: number;
	symbols: number;
	occurrences: number;
	dependencyEdges: number;
	dependencyBindings: number;
	diagnostics: number;
}>;

const createReport = (
	input: Readonly<{generationId: string; reused: boolean; durationMs: number; counts: BuildCountsType; stages: BuildStagesType | null}>,
): BuildReportType => ({
	generationId: input.generationId,
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

const persistFacts = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		files: readonly SourceFileType[];
		facts: ExtractionResultType;
		dependencies: DependencyExtractionResultType;
		diagnostics: readonly DiagnosticType[];
		sourceHash: string;
	}>,
): void => {
	input.database.insertFiles(input.generationId, input.files);
	input.database.insertSymbols(input.generationId, input.facts.symbols);
	input.database.insertOccurrences(input.generationId, input.facts.occurrences);
	input.database.insertDependencyEdges(input.generationId, input.dependencies.edges);
	input.database.insertDependencyBindings(input.generationId, input.dependencies.bindings);
	input.database.insertDiagnostics(input.generationId, input.diagnostics);

	const insertedSymbols = input.database.countRows(input.generationId, 'symbol');
	const insertedOccurrences = input.database.countRows(input.generationId, 'occurrence');
	const insertedEdges = input.database.countRows(input.generationId, 'dependency_edge');
	const insertedBindings = input.database.countRows(input.generationId, 'dependency_binding');

	if (
		insertedSymbols !== input.facts.symbols.length ||
		insertedOccurrences !== input.facts.occurrences.length ||
		insertedEdges !== input.dependencies.edges.length ||
		insertedBindings !== input.dependencies.bindings.length
	) {
		throw new Error(
			`Index insertion count mismatch: symbols ${insertedSymbols}/${input.facts.symbols.length}, occurrences ${insertedOccurrences}/${input.facts.occurrences.length}, dependency edges ${insertedEdges}/${input.dependencies.edges.length}, dependency bindings ${insertedBindings}/${input.dependencies.bindings.length}`,
		);
	}

	input.database.updateSourceHash(input.generationId, input.sourceHash);
};

/**
 * Stores one reusable extraction artifact per file.
 *
 * Identity is the raw content hash, artifact kind, extractor identity, extractor
 * version, and the scan configuration hash that captures compiler options and
 * project context.
 *
 * @param input - Database, generation, files, facts, and artifact context.
 */
const persistArtifacts = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		files: readonly SourceFileType[];
		facts: ExtractionResultType;
		contextHash: string;
		extractorId: string;
		extractorVersion: string;
	}>,
): void => {
	const symbolsByPath = new Map<string, ExtractionResultType['symbols'][number][]>();
	const occurrencesByPath = new Map<string, ExtractionResultType['occurrences'][number][]>();

	for (const symbol of input.facts.symbols) {
		const group = symbolsByPath.get(symbol.path) ?? [];
		group.push(symbol);
		symbolsByPath.set(symbol.path, group);
	}

	for (const occurrence of input.facts.occurrences) {
		const group = occurrencesByPath.get(occurrence.path) ?? [];
		group.push(occurrence);
		occurrencesByPath.set(occurrence.path, group);
	}

	for (const file of input.files) {
		input.database.putExtractionArtifact({
			contentSha256: file.sha256,
			artifactKind: 'symbols',
			extractorId: input.extractorId,
			extractorVersion: input.extractorVersion,
			contextHash: input.contextHash,
			artifactJson: JSON.stringify({
				symbols: symbolsByPath.get(file.path) ?? [],
				occurrences: occurrencesByPath.get(file.path) ?? [],
			}),
		});
	}

	debug('extraction artifacts stored', {generationId: input.generationId, files: input.files.length});
};

/**
 * Stores one dependency edge artifact per file.
 *
 * @param input - Database, files, dependency facts, and artifact context.
 */
const persistDependencyArtifacts = (
	input: Readonly<{
		database: IndexDatabase;
		files: readonly SourceFileType[];
		dependencies: DependencyExtractionResultType;
		contextHash: string;
		extractorId: string;
		extractorVersion: string;
	}>,
): void => {
	const edgesByPath = new Map<string, DependencyExtractionResultType['edges'][number][]>();
	const bindingsByEdge = new Map<string, DependencyExtractionResultType['bindings'][number][]>();

	for (const edge of input.dependencies.edges) {
		const group = edgesByPath.get(edge.sourcePath) ?? [];
		group.push(edge);
		edgesByPath.set(edge.sourcePath, group);
	}

	for (const bindingEntry of input.dependencies.bindings) {
		const group = bindingsByEdge.get(bindingEntry.edgeId) ?? [];
		group.push(bindingEntry);
		bindingsByEdge.set(bindingEntry.edgeId, group);
	}

	for (const file of input.files) {
		const edges = edgesByPath.get(file.path) ?? [];
		input.database.putExtractionArtifact({
			contentSha256: file.sha256,
			artifactKind: 'dependencies',
			extractorId: input.extractorId,
			extractorVersion: input.extractorVersion,
			contextHash: input.contextHash,
			artifactJson: JSON.stringify({
				edges,
				bindings: edges.flatMap((edge) => bindingsByEdge.get(edge.id) ?? []),
			}),
		});
	}
};

const executeBuild = (
	input: Readonly<{
		config: ConfigType;
		database: IndexDatabase;
		logger: LoggerType;
		scan: ScanResultType;
		generationId: string;
		startedAt: number;
		scanMs: number;
	}>,
): BuildReportType => {
	const extractor = extractorFor(input.config.extractorId);
	const extracted = extractor.build(input.config, input.scan);
	const facts: ExtractionResultType = {
		symbols: extracted.symbols,
		occurrences: extracted.occurrences,
		diagnostics: extracted.diagnostics,
		diagnosticCount: extracted.diagnostics.length,
	};
	const insertionStartedAt = performance.now();
	input.database.insertContents(extracted.files);
	persistFacts({
		database: input.database,
		generationId: input.generationId,
		files: extracted.files,
		facts,
		dependencies: extracted.dependencies,
		diagnostics: extracted.diagnostics,
		sourceHash: computeSourceHash(extracted.files),
	});
	persistArtifacts({
		database: input.database,
		generationId: input.generationId,
		files: extracted.files,
		facts,
		contextHash: input.scan.configHash,
		extractorId: input.scan.extractorId,
		extractorVersion: input.scan.extractorVersion,
	});
	persistDependencyArtifacts({
		database: input.database,
		files: extracted.files,
		dependencies: extracted.dependencies,
		contextHash: input.scan.configHash,
		extractorId: input.scan.extractorId,
		extractorVersion: input.scan.extractorVersion,
	});
	const insertionMs = Math.round(performance.now() - insertionStartedAt);
	const verificationStartedAt = performance.now();
	input.database.verifyIntegrity();
	const verificationMs = Math.round(performance.now() - verificationStartedAt);
	const publicationMs = input.database.publish(input.generationId, extracted.diagnostics.length, {
		scanMs: input.scan.scanMs,
		compilerMs: extracted.compilerMs,
		extractionMs: extracted.extractionMs,
		insertionMs,
		verificationMs,
	});
	const stages: BuildStagesType = {
		scanMs: input.scan.scanMs,
		compilerMs: extracted.compilerMs,
		extractionMs: extracted.extractionMs,
		insertionMs,
		verificationMs,
		publicationMs,
	};
	const durationMs = Math.round(performance.now() - input.startedAt);
	const {files} = extracted;

	input.logger.info('index_built', {
		generationId: input.generationId,
		durationMs,
		files: files.length,
		symbols: facts.symbols.length,
		occurrences: facts.occurrences.length,
		dependencyEdges: extracted.dependencies.edges.length,
		dependencyBindings: extracted.dependencies.bindings.length,
		diagnostics: extracted.diagnostics.length,
		stages,
	});

	return createReport({
		generationId: input.generationId,
		reused: false,
		durationMs,
		counts: {
			files: files.length,
			symbols: facts.symbols.length,
			occurrences: facts.occurrences.length,
			dependencyEdges: extracted.dependencies.edges.length,
			dependencyBindings: extracted.dependencies.bindings.length,
			diagnostics: extracted.diagnostics.length,
		},
		stages,
	});
};

/**
 * Builds and atomically publishes one complete index generation.
 *
 * The published generation is replaced only after extraction, insertion, and
 * integrity verification succeed. A failed build leaves the previous generation
 * serving queries.
 *
 * @param input - Resolved configuration, database, logger, and optional scan or forced rebuild.
 * @returns The published or reused generation report.
 * @throws {@link Error} When scanning, loading, extraction, or publication fails.
 */
export const buildGeneration = (input: BuildInputType): BuildReportType => {
	const startedAt = performance.now();
	const published = input.database.getPublishedGeneration();
	const publishedId = published?.id ?? null;
	const knownPaths = publishedId === null ? [] : input.database.listFiles(publishedId).map((file) => file.path);
	const scan = input.scan ?? extractorFor(input.config.extractorId).scan(input.config, knownPaths);
	const {scanMs} = scan;
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
		const durationMs = Math.round(performance.now() - startedAt);
		input.logger.info('index_reused', {generationId: reusable.id, durationMs});
		return createReport({
			generationId: reusable.id,
			reused: true,
			durationMs,
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

	try {
		return executeBuild({
			config: input.config,
			database: input.database,
			logger: input.logger,
			scan,
			generationId,
			startedAt,
			scanMs,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		debug('build failed', {generationId, message});
		input.logger.error('index_build_failed', {generationId, message});
		input.database.markFailed(generationId, message);
		throw error;
	}
};
