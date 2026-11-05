import {type ExtractorArtifactCacheType, type ExtractorBuildType, type ExtractorType} from '../../adapters/types.ts';
import {adapterConfigFor, type ConfigType} from '../config/config.ts';
import {PUBLICATION_SURFACE_BINDINGS_PER_ROOT, finalizeFacts, type FinalizedFactSetType} from '../facts/index.ts';
import {debugFor} from '../logging/debug.ts';
import {type GenerationAdapterType, type GenerationRowType, type ScanResultType} from '../model.ts';
import {type AdapterCommitCountsType, type AdapterCommitType, type IndexDatabase} from '../storage/database.ts';
import {artifactKeyOf, createExtractorCache} from './buildArtifacts.ts';
import {runBuildStage, runBuildStageAsync} from './buildFailure.ts';
import {type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {computeSourceHash} from './sourceFiles.ts';

const debug = debugFor('build');

export const ZERO_COUNTS: AdapterCommitCountsType = {
	files: 0,
	symbols: 0,
	occurrences: 0,
	dependencyEdges: 0,
	dependencyBindings: 0,
	diagnostics: 0,
};

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
 * Reports whether one persisted adapter row still guarantees the scanned facts.
 *
 * @param adapter - Persisted adapter provenance.
 * @param scan - Current scan result.
 * @param target - Loaded adapter implementation.
 * @returns True when extraction and file rewrites can be skipped.
 */
export const adapterMatchesScan = (adapter: GenerationAdapterType, scan: ScanResultType, target: AdapterTargetType): boolean =>
	adapter.coverage === 'present' &&
	adapter.sourceHash === scan.sourceHash &&
	adapter.configHash === scan.configHash &&
	adapter.inputHash === (scan.inputHash ?? scan.configHash) &&
	adapter.adapterVersion === target.extractor.version &&
	adapter.protocolVersion === target.protocolVersion &&
	adapter.compilerVersion === scan.compilerVersion;

const configMatches = (adapter: GenerationAdapterType, scan: ScanResultType, target: AdapterTargetType): boolean =>
	adapter.coverage === 'present' &&
	adapter.configHash === scan.configHash &&
	adapter.inputHash === (scan.inputHash ?? scan.configHash) &&
	adapter.adapterVersion === target.extractor.version &&
	adapter.protocolVersion === target.protocolVersion;

/**
 * Reports whether the published generation still guarantees one adapter's facts.
 *
 * @param input - Adapter implementation, scoped configuration, scan, published
 * manifest, and artifact cache.
 * @returns True when persisted facts can be reused without extraction.
 */
const adapterFactsAreReusable = async (
	input: Readonly<{
		extractor: ExtractorType;
		config: ConfigType;
		scan: ScanResultType;
		database: IndexDatabase;
		cache: ExtractorArtifactCacheType;
		publishedFiles: readonly Readonly<{path: string; sha256: string}>[];
	}>,
): Promise<boolean> => {
	if (input.extractor.canReusePublishedFacts === undefined) {
		return false;
	}

	const startedAt = performance.now();
	const reusable = await input.extractor.canReusePublishedFacts({
		config: input.config,
		scan: input.scan,
		publishedFiles: input.publishedFiles,
		read: (artifact) => input.database.getExtractionArtifact(artifactKeyOf(input.scan, artifact)),
		write: (artifact) => {
			input.cache.write(artifact);
		},
	});
	debug('fact reuse probe', {adapterId: input.scan.extractorId, reusable, durationMs: Math.round(performance.now() - startedAt)});
	return reusable;
};

const previousCountsOf = (adapter: GenerationAdapterType): AdapterCommitCountsType => ({
	files: adapter.fileCount,
	symbols: adapter.symbolCount,
	occurrences: adapter.occurrenceCount,
	dependencyEdges: adapter.dependencyEdgeCount,
	dependencyBindings: adapter.dependencyBindingCount,
	diagnostics: adapter.diagnosticCount,
});

/**
 * Builds one adapter's contribution to a multi-adapter publication.
 *
 * An adapter whose complete reuse key still matches is not re-extracted. When
 * only source bytes changed, an adapter-supplied proof may retain published
 * facts while its file rows are synchronized.
 *
 * @param input - Plan, target, previous row, configuration, and persist callback.
 * @returns The adapter contribution.
 */
export const adapterCommitOf = async (
	input: Readonly<{
		plan: AdapterScanPlanType;
		target: AdapterTargetType;
		previous: GenerationAdapterType | undefined;
		config: ConfigType;
		database: IndexDatabase;
		published: GenerationRowType | null;
		force: boolean | undefined;
		override: ExtractorType | undefined;
		persist: (cache: ReturnType<typeof createExtractorCache>) => void;
	}>,
): Promise<AdapterCommitType> => {
	const {plan, target, previous} = input;
	const adapterVersion = target.extractor.version;
	const provenance = {
		protocolVersion: target.protocolVersion,
		packageName: target.packageName,
		packageVersion: target.packageVersion,
	} as const;

	if (plan.coverage === 'absent' || plan.scan === null) {
		return {
			adapterId: plan.adapterId,
			...provenance,
			adapterVersion,
			compilerVersion: 'unknown',
			declaredCompilerVersion: null,
			compilerDrift: false,
			coverage: 'absent',
			absenceReason: plan.absenceReason,
			sourceHash: `absent:${plan.absenceReason ?? 'unknown'}`,
			configHash: target.extractor.version,
			inputHash: target.extractor.version,
			counts: ZERO_COUNTS,
			stages: {scanMs: 0, compilerMs: 0, extractionMs: 0},
			files: [],
			projects: [],
		};
	}

	const {scan} = plan;
	const scoped = adapterConfigFor(input.config, target.adapter);
	const base = {
		adapterId: plan.adapterId,
		...provenance,
		adapterVersion,
		compilerVersion: scan.compilerVersion,
		declaredCompilerVersion: scan.declaredCompilerVersion,
		compilerDrift: scan.compilerDrift,
		coverage: 'present' as const,
		absenceReason: null,
		sourceHash: scan.sourceHash,
		configHash: scan.configHash,
		inputHash: scan.inputHash ?? scan.configHash,
		stages: {scanMs: scan.scanMs, compilerMs: 0, extractionMs: 0},
		files: scan.files,
		projects: scan.projects,
	};

	if (input.force !== true && previous !== undefined && adapterMatchesScan(previous, scan, target)) {
		return {...base, counts: previousCountsOf(previous)};
	}

	const cache = createExtractorCache(input.database, scan);
	const reusableFacts =
		input.force !== true &&
		input.published !== null &&
		previous !== undefined &&
		configMatches(previous, scan, target) &&
		(await adapterFactsAreReusable({
			extractor: target.extractor,
			config: scoped,
			scan,
			database: input.database,
			cache: cache.cache,
			publishedFiles: input.database.listFiles(input.published.id, plan.adapterId),
		}));

	if (reusableFacts) {
		input.persist(cache);
		return {...base, counts: previousCountsOf(previous)};
	}

	const extracted = await runBuildStageAsync('extraction', async () => {
		const result = await target.extractor.build(scoped, scan, cache.cache);
		return result;
	});
	const finalized = finalizePublication(extracted, input.override === undefined ? plan.adapterId : null);
	runBuildStage('validation', () => extracted.validate?.());
	input.persist(cache);

	return {
		...base,
		sourceHash: computeSourceHash(extracted.files),
		files: extracted.files,
		stages: {scanMs: scan.scanMs, compilerMs: extracted.compilerMs, extractionMs: extracted.extractionMs},
		counts: ZERO_COUNTS,
		facts: finalized,
		dependencies: extracted.dependencies,
		diagnostics: extracted.diagnostics,
	};
};
