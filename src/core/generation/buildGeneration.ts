import {randomUUID} from 'node:crypto';
import {type ExtractorType} from '../../adapters/types.ts';
import {type AdapterSetType} from '../../adapters/loader.ts';
import {adapterConfigFor, type ConfigType} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildReportType, type BuildStagesType, type GenerationAdapterType, type GenerationRowType, type ScanResultType} from '../model.ts';
import {type AdapterCommitCountsType, type IndexDatabase} from '../storage/database.ts';
import {createReport, durationOf} from './buildReport.ts';
import {type createExtractorCache} from './buildArtifacts.ts';
import {runAdapterStageAsync, runBuildStage, runBuildStageAsync} from './buildFailure.ts';
import {hashEntriesOf, plansMatchPrevious, preservedHashEntries} from './buildHashes.ts';
import {failedBuild, reusedReport, supersededReport} from './buildReports.ts';
import {adapterCommitOf} from './adapterCommit.ts';
import {
	type AdapterTargetType,
	AdapterContractError,
	adapterTargets,
	assertAdapterIdentity,
	assertSharedExtractedFiles,
	assertSharedPaths,
	combinedAdapterHashesOf,
	probeAdapter,
	type AdapterScanPlanType,
} from './adapterBuild.ts';

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
	/**
	 * Cooperative cancellation check.
	 *
	 * The worker sets this from a cancel message; in-process builds derive it
	 * from the coordinator's abort signal. It is checked between adapters and
	 * before publication, where discarding the candidate is still safe.
	 */
	isCancelled?: (() => boolean) | undefined;
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
}>;

type PreparedBuildType = Readonly<{
	published: GenerationRowType | null;
	scans: readonly AdapterScanPlanType[];
	targets: readonly AdapterTargetType[];
	previousAdapters: readonly GenerationAdapterType[];
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

const persistCachesSafely = (action: () => void): void => {
	try {
		action();
	} catch (error) {
		// Artifacts are derived and rebuildable; losing them costs work, never correctness.
		debug('artifact cache persistence failed', {message: error instanceof Error ? error.message : String(error)});
	}
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

const scanPlansOf = async (
	input: BuildInputType,
	targets: readonly AdapterTargetType[],
	published: GenerationRowType | null,
): Promise<readonly AdapterScanPlanType[]> => {
	if (input.scan !== undefined) {
		const [target] = targets;

		if (target === undefined || targets.length !== 1) {
			throw new AdapterContractError('A singular scan requires exactly one configured adapter');
		}

		return [{adapterId: target.adapter.id, coverage: 'present', absenceReason: null, scan: input.scan}];
	}

	if (input.scans !== undefined) {
		const configured = new Set(targets.map((target) => target.adapter.id));

		for (const plan of input.scans) {
			if (!configured.has(plan.adapterId)) {
				throw new AdapterContractError(`Scan plan names an unconfigured adapter: ${plan.adapterId}`);
			}

			if (plan.scan !== null && plan.scan.extractorId !== plan.adapterId) {
				throw new AdapterContractError(`Scan plan for ${plan.adapterId} carries facts from ${plan.scan.extractorId}`);
			}
		}

		if (new Set(input.scans.map((plan) => plan.adapterId)).size !== input.scans.length) {
			throw new AdapterContractError('Scan plans name an adapter more than once');
		}

		return input.scans;
	}

	const plans: AdapterScanPlanType[] = [];

	for (const target of targets) {
		const scoped = adapterConfigFor(input.config, target.adapter);
		// Adapter probes are sequential so absence and failure attribution follow
		// configuration order.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const probe = await runAdapterStageAsync(target.adapter.id, async () => {
			const result = await probeAdapter(target, scoped);
			return result;
		});

		if (probe.coverage === 'absent') {
			plans.push({adapterId: target.adapter.id, coverage: 'absent', absenceReason: probe.reason, scan: null});
			continue;
		}

		const knownPaths = published === null ? [] : input.database.listFiles(published.id, target.adapter.id).map((file) => file.path);
		// oxlint-disable-next-line eslint/no-await-in-loop
		const scan = await runAdapterStageAsync(target.adapter.id, async () => {
			const staged = await runBuildStageAsync('scan', async () => {
				const result = await target.extractor.scan(scoped, knownPaths);
				return result;
			});

			return staged;
		});

		plans.push({adapterId: target.adapter.id, coverage: 'present', absenceReason: null, scan});
	}

	return plans;
};

const prepareBuild = async (input: BuildInputType): Promise<PreparedBuildType> => {
	const published = input.database.getPublishedGeneration();
	const targets = adapterTargets(input.config, input.adapters, input.extractor);
	const scans = await scanPlansOf(input, targets, published);
	assertSharedPaths(scans);

	const previousAdapters = published === null ? [] : input.database.getGenerationAdapters(published.id);
	const planned = new Set(scans.map((plan) => plan.adapterId));

	if (scans.length === 0) {
		throw new AdapterContractError('A build requires at least one adapter scan plan');
	}

	if (planned.size < targets.length) {
		if (published === null) {
			throw new AdapterContractError('A targeted refresh requires a published generation');
		}

		const persisted = new Set(previousAdapters.map((adapter) => adapter.adapterId));

		for (const target of targets) {
			if (!planned.has(target.adapter.id) && !persisted.has(target.adapter.id)) {
				throw new AdapterContractError(`A targeted refresh omitted adapter ${target.adapter.id} without a persisted row`);
			}
		}
	}

	return {published, scans, targets, previousAdapters};
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
		const target = targetsById.get(plan.adapterId);

		if (target === undefined) {
			throw new AdapterContractError(`No adapter target for ${plan.adapterId}`);
		}

		const early = cancelledReport(context);

		if (early !== null) {
			return early;
		}

		// Adapters extract sequentially so one adapter's failure preserves the
		// previous generation before the next adapter runs.
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

	const commit = context.database.commitAdapters({
		generationId: context.generationId,
		adapters,
		removedAdapterIds,
		...combinedHashes,
		mode: context.mode,
		startedAt: context.startedAtIso,
		...(context.ownerId === undefined ? {} : {ownerId: context.ownerId}),
	});
	const durationMs = durationOf(context.startedAt, commit.stages);

	for (const cache of caches) {
		persistCachesSafely(() => {
			cache.flush();
		});
	}

	// Artifact persistence happens after the publication transaction and can add
	// one build's extraction footprint to the WAL. Reclaim it only after both
	// publication and derived writes are complete.
	context.database.tryCheckpoint();

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
	});
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
	const startedAtIso = new Date(startedAt).toISOString();
	const {published, scans, targets, previousAdapters} = await prepareBuild(input);
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
		const report = supersededReport({generationId: published?.id ?? '', published, startedAt});
		input.logger.info('index_build_cancelled', {generationId: report.generationId, durationMs: report.durationMs});
		return report;
	}

	let generationId = '';
	let mode: 'insert' | 'revise' = 'revise';

	try {
		const begun = runBuildStage('persistence', () => beginGeneration(input, published, hashes));
		({generationId, mode} = begun);

		const report = await commitAdapters({
			config: input.config,
			database: input.database,
			logger: input.logger,
			published,
			plans: scans,
			targets,
			generationId,
			mode,
			startedAt,
			startedAtIso,
			force: input.force,
			extractorOverride: input.extractor,
			ownerId: input.ownerId,
			isCancelled: input.isCancelled,
		});

		return report;
	} catch (error) {
		return failedBuild({
			error,
			generationId,
			mode,
			published,
			scans,
			startedAt,
			database: input.database,
			logger: input.logger,
		});
	}
};
