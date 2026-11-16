import {randomUUID} from 'node:crypto';
import {type ExtractorType} from '../../adapters/types.ts';
import {type AdapterExecutionContextType} from '@codeindex/adapter-sdk';
import {type AdapterSetType} from '../../adapters/loader.ts';
import {type ConfigType} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {
	type BuildPersistenceType,
	type BuildReportType,
	type BuildStagesType,
	type GenerationAdapterType,
	type GenerationRowType,
	type ScanResultType,
} from '../model.ts';
import {type AdapterCommitCountsType, type IndexDatabase} from '../storage/database.ts';
import {adapterActivityOf, createReport, durationOf} from './buildReport.ts';
import {type createExtractorCache} from './buildArtifacts.ts';
import {runAdapterStageAsync, runBuildStage} from './buildFailure.ts';
import {hashEntriesOf, plansMatchPrevious, preservedHashEntries} from './buildHashes.ts';
import {failedBuild, reusedReport, supersededReport} from './buildReports.ts';
import {adapterCommitOf} from './adapterCommit.ts';
import {
	type AdapterTargetType,
	AdapterContractError,
	assertAdapterIdentity,
	assertSharedExtractedFiles,
	combinedAdapterHashesOf,
	type AdapterScanPlanType,
} from './adapterBuild.ts';
import {BuildCancellationError} from './executionCancellation.ts';
import {prepareBuild, type PreparedBuildType} from './buildPreparation.ts';
import {type BuildProgressType} from './buildProgress.ts';

const debug = debugFor('build');

type BuildInputType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	logger: LoggerType;
	scans?: readonly AdapterScanPlanType[];
	/** Legacy singular scan input; only valid with one configured adapter. */
	scan?: ScanResultType;
	force?: boolean;
	ownerId?: string;
	/**
	 * Epoch milliseconds at which this attempt started, including a scan that
	 * the caller already performed. Keeps reported duration covering every stage.
	 */
	startedAtEpoch?: number;
	/** Qualification-only adapter override; production resolves from the loaded set. */
	extractor?: ExtractorType;
	/** Loaded adapters selected by the composition root. */
	adapters: AdapterSetType;
	/** Adapter scope selected by the scheduler; null scans every adapter. */
	adapterIds?: readonly string[] | null;
	/**
	 * Cooperative cancellation check.
	 *
	 * The worker sets this from a cancel message; in-process builds derive it
	 * from the coordinator's abort signal. It is checked between adapters and
	 * before publication, where discarding the candidate is still safe.
	 */
	isCancelled?: (() => boolean) | undefined;
	/** Shared-memory-backed context passed to official adapter work. */
	executionContext?: AdapterExecutionContextType | undefined;
	/** Receives serializable scan plans for worker watch-plan updates. */
	onScans?: ((scans: readonly AdapterScanPlanType[]) => void) | undefined;
	onProgress?: ((progress: BuildProgressType) => void) | undefined;
}>;

type CommitContextType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	logger: LoggerType;
	published: GenerationRowType | null;
	plans: readonly AdapterScanPlanType[];
	targets: readonly AdapterTargetType[];
	generationId: string;
	mode: 'insert' | 'revise';
	startedAt: number;
	startedAtIso: string;
	force: boolean | undefined;
	extractorOverride: ExtractorType | undefined;
	ownerId: string | undefined;
	isCancelled: (() => boolean) | undefined;
	executionContext: AdapterExecutionContextType | undefined;
	onProgress: ((progress: BuildProgressType) => void) | undefined;
}>;

const logBuild = (
	input: Readonly<{
		logger: LoggerType;
		generationId: string;
		revision: number;
		durationMs: number;
		reusedFacts: boolean;
		counts: AdapterCommitCountsType;
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

const persistCachesSafely = (action: () => void): boolean => {
	try {
		action();
		return true;
	} catch (error) {
		// Artifacts are derived and rebuildable; losing them costs work, never correctness.
		debug('artifact cache persistence failed', {message: error instanceof Error ? error.message : String(error)});
		return false;
	}
};

const completePersistence = (
	input: Readonly<{
		database: IndexDatabase;
		caches: readonly ReturnType<typeof createExtractorCache>[];
		startedAt: number;
		base: BuildPersistenceType;
		isCancelled?: () => boolean;
	}>,
): BuildPersistenceType => {
	const artifactFlushStartedAt = performance.now();
	let artifactFlushFailures = 0;

	for (const cache of input.caches) {
		if (input.isCancelled?.() === true) {
			break;
		}

		if (!persistCachesSafely(cache.flush)) {
			artifactFlushFailures += 1;
		}
	}

	const artifactFlushMs = Math.round(performance.now() - artifactFlushStartedAt);
	const postArtifactCheckpoint = input.database.tryCheckpoint();
	return {
		...input.base,
		artifactFlushMs,
		artifactFlushFailures,
		postArtifactCheckpoint,
		totalWallMs: Math.round(performance.now() - input.startedAt),
	};
};

const rosterMatches = (plans: readonly AdapterScanPlanType[], adapters: readonly {adapterId: string; coverage: string}[]): boolean => {
	if (plans.length !== adapters.length) {
		return false;
	}

	const stored = new Map(adapters.map((adapter) => [adapter.adapterId, adapter.coverage]));

	return plans.every((plan) => stored.get(plan.adapterId) === plan.coverage);
};

const reusableMatches = (
	input: Readonly<{
		reusable: GenerationRowType | null;
		published: GenerationRowType | null;
		scans: readonly AdapterScanPlanType[];
		previousAdapters: readonly GenerationAdapterType[];
		targets: readonly AdapterTargetType[];
		fullScope: boolean;
		database: IndexDatabase;
	}>,
): boolean => {
	const {reusable} = input;

	if (reusable === null) {
		return false;
	}

	if (input.fullScope) {
		return rosterMatches(input.scans, input.database.getGenerationAdapters(reusable.id));
	}

	return reusable.id === input.published?.id && plansMatchPrevious(input.scans, input.previousAdapters, input.targets);
};

const beginGeneration = (
	input: BuildInputType,
	published: GenerationRowType | null,
	hashes: Readonly<{sourceHash: string; configHash: string; inputHash: string}>,
): Readonly<{generationId: string; mode: 'insert' | 'revise'}> => {
	if (published !== null) {
		return {generationId: published.id, mode: 'revise'};
	}

	const generationId = randomUUID();

	input.database.createGeneration({
		id: generationId,
		sourceHash: hashes.sourceHash,
		configHash: hashes.configHash,
		inputHash: hashes.inputHash,
	});

	return {generationId, mode: 'insert'};
};

const cancelledReport = (context: CommitContextType): BuildReportType | null => {
	if (context.isCancelled?.() !== true) {
		return null;
	}

	if (context.mode === 'insert') {
		context.database.discardBuildingGeneration(context.generationId);
	}

	const report = supersededReport({generationId: context.generationId, published: context.published, startedAt: context.startedAt});
	context.logger.info('index_build_cancelled', {generationId: context.generationId, durationMs: report.durationMs});
	return report;
};

const commitAdapters = async (context: CommitContextType): Promise<BuildReportType> => {
	const previousById = new Map(context.database.getGenerationAdapters(context.generationId).map((adapter) => [adapter.adapterId, adapter]));
	const configured = new Set(context.targets.map((target) => target.adapter.id));
	const removedAdapterIds = [...previousById.keys()].filter((adapterId) => !configured.has(adapterId));
	const caches: ReturnType<typeof createExtractorCache>[] = [];
	const persist = (cache: ReturnType<typeof createExtractorCache>): void => {
		caches.push(cache);
	};
	const targetsById = new Map(context.targets.map((target) => [target.adapter.id, target]));

	const adapters = [];

	for (const plan of context.plans) {
		context.onProgress?.({phase: 'building', adapterId: plan.adapterId});
		const target = targetsById.get(plan.adapterId);

		if (target === undefined) {
			throw new AdapterContractError(`No adapter target for ${plan.adapterId}`);
		}

		const early = cancelledReport(context);

		if (early !== null) {
			return early;
		}

		adapters.push(
			// oxlint-disable-next-line eslint/no-await-in-loop
			await runAdapterStageAsync(plan.adapterId, async () => {
				const contribution = await adapterCommitOf({
					plan,
					target,
					previous: previousById.get(plan.adapterId),
					config: context.config,
					database: context.database,
					published: context.database.getPublishedGeneration(),
					force: context.force,
					override: context.extractorOverride,
					persist,
					...(context.executionContext === undefined ? {} : {executionContext: context.executionContext}),
				});
				return contribution;
			}),
		);
	}

	const afterExtraction = cancelledReport(context);

	if (afterExtraction !== null) {
		return afterExtraction;
	}

	assertAdapterIdentity(adapters);
	assertSharedExtractedFiles(adapters);

	const extracted = new Set(adapters.map((adapter) => adapter.adapterId));
	const preserved = preservedHashEntries(context.targets, extracted, previousById);
	const combinedHashes = combinedAdapterHashesOf([
		...adapters.map((adapter) => ({
			adapterId: adapter.adapterId,
			coverage: adapter.coverage,
			reason: adapter.absenceReason,
			sourceHash: adapter.sourceHash,
			configHash: adapter.configHash,
			inputHash: adapter.inputHash,
		})),
		...preserved,
	]);

	const persistenceStartedAt = performance.now();
	context.onProgress?.({phase: 'publishing', adapterId: null});
	const commit = context.database.commitAdapters({
		generationId: context.generationId,
		adapters,
		removedAdapterIds,
		...combinedHashes,
		mode: context.mode,
		startedAt: context.startedAtIso,
		...(context.ownerId === undefined ? {} : {ownerId: context.ownerId}),
		...(context.isCancelled === undefined ? {} : {isCancelled: context.isCancelled}),
	});
	const persistence = completePersistence({
		database: context.database,
		caches,
		startedAt: persistenceStartedAt,
		base: commit.persistence,
		...(context.isCancelled === undefined ? {} : {isCancelled: context.isCancelled}),
	});
	const durationMs = durationOf(context.startedAt, commit.stages);

	logBuild({
		logger: context.logger,
		generationId: context.generationId,
		revision: commit.revision,
		durationMs,
		reusedFacts: false,
		counts: commit.counts,
		stages: commit.stages,
	});

	return createReport({
		generationId: context.generationId,
		revision: commit.revision,
		outcome: 'published',
		reused: false,
		durationMs,
		counts: commit.counts,
		stages: commit.stages,
		persistence,
		adapterActivity: adapterActivityOf(adapters),
	});
};

const isBuildCancellation = (error: unknown, input: BuildInputType): boolean => error instanceof BuildCancellationError || input.isCancelled?.() === true;

const cancellationReport = (input: BuildInputType, published: GenerationRowType | null, generationId: string, startedAt: number): BuildReportType => {
	const report = supersededReport({generationId: published?.id ?? generationId, published, startedAt});
	input.logger.info('index_build_cancelled', {generationId: report.generationId, durationMs: report.durationMs});
	return report;
};

const prepareBuildOrCancel = async (
	input: BuildInputType,
	startedAt: number,
): Promise<Readonly<{prepared: PreparedBuildType; report: null}> | Readonly<{prepared: null; report: BuildReportType}>> => {
	try {
		return {prepared: await prepareBuild(input), report: null};
	} catch (error) {
		if (!isBuildCancellation(error, input)) {
			throw error;
		}

		const published = input.database.getPublishedGeneration();
		return {prepared: null, report: cancellationReport(input, published, published?.id ?? '', startedAt)};
	}
};

const publishPreparedBuild = async (
	input: BuildInputType,
	prepared: PreparedBuildType,
	hashes: Readonly<{sourceHash: string; configHash: string; inputHash: string}>,
	startedAt: number,
): Promise<BuildReportType> => {
	const {published, scans, targets} = prepared;
	let generationId = '';
	let mode: 'insert' | 'revise' = 'revise';

	try {
		const begun = runBuildStage('persistence', () => beginGeneration(input, published, hashes));
		({generationId, mode} = begun);
		return await commitAdapters({
			config: input.config,
			database: input.database,
			logger: input.logger,
			published,
			plans: scans,
			targets,
			generationId,
			mode,
			startedAt,
			startedAtIso: new Date(startedAt).toISOString(),
			force: input.force,
			extractorOverride: input.extractor,
			ownerId: input.ownerId,
			isCancelled: input.isCancelled,
			executionContext: input.executionContext,
			onProgress: input.onProgress,
		});
	} catch (error) {
		if (!isBuildCancellation(error, input)) {
			return failedBuild({error, generationId, mode, published, scans, startedAt, database: input.database, logger: input.logger});
		}

		if (mode === 'insert' && generationId.length > 0) {
			input.database.discardBuildingGeneration(generationId);
		}

		return cancellationReport(input, published, generationId, startedAt);
	}
};

const buildPrepared = async (input: BuildInputType, prepared: PreparedBuildType, startedAt: number): Promise<BuildReportType> => {
	const {published, scans, targets, previousAdapters} = prepared;
	input.onScans?.(scans);
	const hashes = combinedAdapterHashesOf(hashEntriesOf(scans, previousAdapters, targets));
	const reusable = input.force === true ? null : input.database.findReusableGeneration(hashes.sourceHash, hashes.configHash, hashes.inputHash);
	const fullScope = scans.length === targets.length;
	debug('build start', {
		force: input.force === true,
		scansProvided: input.scans !== undefined,
		published: published?.id ?? null,
		adapters: scans.map((plan) => `${plan.adapterId}:${plan.coverage}`),
		fullScope,
		reusable: reusable?.id ?? null,
	});

	if (reusable !== null && reusableMatches({reusable, published, scans, previousAdapters, targets, fullScope, database: input.database})) {
		const report = reusedReport(reusable, startedAt);
		input.logger.info('index_reused', {generationId: reusable.id, revision: reusable.revision, durationMs: report.durationMs});
		return report;
	}

	if (input.isCancelled?.() === true) {
		return cancellationReport(input, published, published?.id ?? '', startedAt);
	}

	const report = await publishPreparedBuild(input, prepared, hashes, startedAt);
	return report;
};

/**
 * Builds and atomically publishes one complete index generation.
 *
 * Every configured adapter contributes one candidate in one transaction. The
 * published generation identifier is stable. An adapter whose complete reuse key
 * still matches is not re-extracted, and a changed adapter never forces another
 * adapter to be re-extracted. A failed build leaves the previous published
 * revision serving queries.
 *
 * @param input - Resolved configuration, database, logger, and optional scans or forced rebuild.
 * @returns The published or reused generation report.
 * @throws {@link Error} When scanning, loading, extraction, or publication fails.
 */
export const buildGeneration = async (input: BuildInputType): Promise<BuildReportType> => {
	const startedAt = input.startedAtEpoch ?? Date.now();
	const outcome = await prepareBuildOrCancel(input, startedAt);

	if (outcome.report !== null) {
		return outcome.report;
	}

	return buildPrepared(input, outcome.prepared, startedAt);
};
