import {randomUUID} from 'node:crypto';
import {extractorFor} from '../../adapters/registry.ts';
import {type ExtractorType} from '../../adapters/types.ts';
import {adapterConfigFor, type AdapterConfigType, type ConfigType} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildOutcomeType, type BuildReportType, type BuildStagesType, type GenerationRowType, type ScanResultType} from '../model.ts';
import {type AdapterCommitCountsType, type IndexDatabase} from '../storage/database.ts';
import {type createExtractorCache} from './buildArtifacts.ts';
import {type BuildProjectContextType, buildFailureOf, buildProjectContextOf, runBuildStage} from './buildFailure.ts';
import {adapterCommitOf, ZERO_COUNTS} from './adapterCommit.ts';
import {
	AdapterContractError,
	adapterTargets,
	assertSharedPaths,
	combinedAdapterHashesOf,
	combinedHashesOf,
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
	/** Qualification-only adapter override; production resolves from the registry. */
	extractor?: ExtractorType;
	/** Qualification/test-only adapter set override; production resolves from the registry. */
	extractors?: readonly ExtractorType[];
}>;

type CommitContextType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	logger: LoggerType;
	plans: readonly AdapterScanPlanType[];
	targets: readonly Readonly<{adapter: AdapterConfigType; extractor: ExtractorType}>[];
	generationId: string;
	mode: 'insert' | 'revise';
	startedAt: number;
	startedAtIso: string;
	force: boolean | undefined;
	extractorOverride: ExtractorType | undefined;
	ownerId: string | undefined;
}>;

type PreparedBuildType = Readonly<{
	published: GenerationRowType | null;
	scans: readonly AdapterScanPlanType[];
	targets: readonly Readonly<{adapter: AdapterConfigType; extractor: ExtractorType}>[];
}>;

const createReport = (
	input: Readonly<{
		generationId: string;
		revision: number;
		outcome: Exclude<BuildOutcomeType, 'failed'>;
		reused: boolean;
		durationMs: number;
		counts: AdapterCommitCountsType;
		stages: BuildStagesType | null;
	}>,
): BuildReportType => ({
	generationId: input.generationId,
	revision: input.revision,
	state: 'published',
	outcome: input.outcome,
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

const countsOf = (generation: GenerationRowType): AdapterCommitCountsType => ({
	files: generation.fileCount,
	symbols: generation.symbolCount,
	occurrences: generation.occurrenceCount,
	dependencyEdges: generation.dependencyEdgeCount,
	dependencyBindings: generation.dependencyBindingCount,
	diagnostics: generation.diagnosticCount,
});

const stageTotalOf = (stages: BuildStagesType | null): number =>
	stages === null ? 0 : stages.scanMs + stages.compilerMs + stages.extractionMs + stages.insertionMs + stages.verificationMs + stages.publicationMs;

/**
 * Keeps the reported attempt at least as long as its independently rounded stages.
 *
 * @param startedAt - Epoch milliseconds when the attempt started.
 * @param stages - Exclusive stage durations, or null when nothing was measured.
 * @returns Wall-clock duration in milliseconds.
 */
const durationOf = (startedAt: number, stages: BuildStagesType | null): number => Math.max(Math.round(Date.now() - startedAt), stageTotalOf(stages));

const projectContextOf = (plans: readonly AdapterScanPlanType[]): BuildProjectContextType | null => {
	const scan = plans.find((plan) => plan.scan !== null)?.scan ?? null;
	return scan === null ? null : buildProjectContextOf(scan.projects);
};

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

const resolveExtractor = (extractors: readonly ExtractorType[] | undefined): ((id: string) => ExtractorType) =>
	extractors === undefined ? extractorFor : (id) => extractors.find((candidate) => candidate.id === id) ?? extractorFor(id);

const scanPlansOf = (
	input: BuildInputType,
	targets: readonly Readonly<{adapter: AdapterConfigType; extractor: ExtractorType}>[],
	published: GenerationRowType | null,
): readonly AdapterScanPlanType[] => {
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

		if (input.scans.length !== targets.length) {
			throw new AdapterContractError('Scan plans do not cover every configured adapter');
		}

		return input.scans;
	}

	return targets.map((target) => {
		const scoped = adapterConfigFor(input.config, target.adapter);
		const probe = probeAdapter(target, scoped);

		if (probe.coverage === 'absent') {
			return {adapterId: target.adapter.id, coverage: 'absent', absenceReason: probe.reason, scan: null};
		}

		const knownPaths = published === null ? [] : input.database.listFiles(published.id, target.adapter.id).map((file) => file.path);
		const scan = runBuildStage('scan', () => target.extractor.scan(scoped, knownPaths));

		return {adapterId: target.adapter.id, coverage: 'present', absenceReason: null, scan};
	});
};

const prepareBuild = (input: BuildInputType): PreparedBuildType => {
	const published = input.database.getPublishedGeneration();
	const targets = adapterTargets(input.config, resolveExtractor(input.extractors), input.extractor);
	const scans = scanPlansOf(input, targets, published);
	assertSharedPaths(scans);

	return {published, scans, targets};
};

const beginGeneration = (
	input: BuildInputType,
	published: GenerationRowType | null,
	plans: readonly AdapterScanPlanType[],
	hashes: Readonly<{sourceHash: string; configHash: string; inputHash: string}>,
): Readonly<{generationId: string; mode: 'insert' | 'revise'}> => {
	if (published !== null) {
		return {generationId: published.id, mode: 'revise'};
	}

	const generationId = randomUUID();
	const primary = plans.find((plan) => plan.scan !== null)?.scan;
	const adapterVersion = primary?.extractorVersion ?? 'unknown';

	input.database.createGeneration({
		id: generationId,
		extractorId: plans[0]?.adapterId ?? 'unknown',
		extractorVersion: adapterVersion,
		compilerVersion: primary?.compilerVersion ?? 'unknown',
		declaredCompilerVersion: primary?.declaredCompilerVersion ?? null,
		compilerDrift: primary?.compilerDrift ?? false,
		sourceHash: hashes.sourceHash,
		configHash: hashes.configHash,
		inputHash: hashes.inputHash,
	});

	return {generationId, mode: 'insert'};
};

const commitAdapters = (context: CommitContextType): BuildReportType => {
	const previousById = new Map(context.database.getGenerationAdapters(context.generationId).map((adapter) => [adapter.adapterId, adapter]));
	const configured = new Set(context.plans.map((plan) => plan.adapterId));
	const removedAdapterIds = [...previousById.keys()].filter((adapterId) => !configured.has(adapterId));
	const caches: ReturnType<typeof createExtractorCache>[] = [];
	const persist = (cache: ReturnType<typeof createExtractorCache>): void => {
		caches.push(cache);
	};
	const targetsById = new Map(context.targets.map((target) => [target.adapter.id, target]));

	const adapters = context.plans.map((plan) => {
		const target = targetsById.get(plan.adapterId);

		if (target === undefined) {
			throw new AdapterContractError(`No adapter target for ${plan.adapterId}`);
		}

		return adapterCommitOf({
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
	});

	const commit = context.database.commitAdapters({
		generationId: context.generationId,
		adapters,
		removedAdapterIds,
		...combinedAdapterHashesOf(
			adapters.map((adapter) => ({
				adapterId: adapter.adapterId,
				coverage: adapter.coverage,
				reason: adapter.absenceReason,
				sourceHash: adapter.sourceHash,
				configHash: adapter.configHash,
				inputHash: adapter.inputHash,
			})),
		),
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

const reusedReport = (reusable: GenerationRowType, startedAt: number): BuildReportType =>
	createReport({
		generationId: reusable.id,
		revision: reusable.revision,
		outcome: 'reused',
		reused: true,
		durationMs: Math.round(Date.now() - startedAt),
		counts: countsOf(reusable),
		stages: null,
	});

const supersededReport = (
	input: Readonly<{
		generationId: string;
		published: GenerationRowType | null;
		startedAt: number;
	}>,
): BuildReportType =>
	createReport({
		generationId: input.published?.id ?? input.generationId,
		revision: input.published?.revision ?? 0,
		outcome: 'superseded',
		reused: false,
		durationMs: Math.round(Date.now() - input.startedAt),
		counts: input.published === null ? ZERO_COUNTS : countsOf(input.published),
		stages: null,
	});

const failedBuild = (
	input: Readonly<{
		error: unknown;
		generationId: string;
		mode: 'insert' | 'revise';
		published: GenerationRowType | null;
		scans: readonly AdapterScanPlanType[];
		startedAt: number;
		database: IndexDatabase;
		logger: LoggerType;
	}>,
): BuildReportType => {
	const {error} = input;
	const failure = buildFailureOf(error, 'publication', projectContextOf(input.scans), input.scans.length === 1 ? (input.scans[0]?.adapterId ?? null) : null);

	// A candidate whose captured inputs changed is discarded. The previous
	// published revision stays in place and the caller retries.
	if (failure.cause === 'source-changed') {
		if (input.mode === 'insert') {
			input.database.discardBuildingGeneration(input.generationId);
		}

		const report = supersededReport({generationId: input.generationId, published: input.published, startedAt: input.startedAt});
		debug('build superseded', {generationId: input.generationId, stage: failure.stage, durationMs: report.durationMs});
		input.logger.info('index_build_superseded', {generationId: input.generationId, stage: failure.stage, durationMs: report.durationMs});
		return report;
	}

	const message = error instanceof Error ? error.message : String(error);
	debug('build failed', {generationId: input.generationId, message, cause: failure.cause, stage: failure.stage, errno: failure.errno});
	input.logger.error('index_build_failed', {generationId: input.generationId, message, cause: failure.cause, stage: failure.stage, errno: failure.errno});

	if (input.mode === 'insert') {
		input.database.markFailed(input.generationId, message);
	}

	throw error;
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
export const buildGeneration = (input: BuildInputType): BuildReportType => {
	const startedAt = input.startedAtEpoch ?? Date.now();
	const startedAtIso = new Date(startedAt).toISOString();
	const {published, scans, targets} = prepareBuild(input);
	const hashes = combinedHashesOf(scans);
	const reusable = input.force === true ? null : input.database.findReusableGeneration(hashes.sourceHash, hashes.configHash, hashes.inputHash);
	debug('build start', {
		force: input.force === true,
		scansProvided: input.scans !== undefined,
		published: published?.id ?? null,
		adapters: scans.map((plan) => `${plan.adapterId}:${plan.coverage}`),
		reusable: reusable?.id ?? null,
	});

	if (reusable !== null && rosterMatches(scans, input.database.getGenerationAdapters(reusable.id))) {
		const report = reusedReport(reusable, startedAt);
		input.logger.info('index_reused', {generationId: reusable.id, revision: reusable.revision, durationMs: report.durationMs});
		return report;
	}

	let generationId = '';
	let mode: 'insert' | 'revise' = 'revise';

	try {
		const begun = runBuildStage('persistence', () => beginGeneration(input, published, scans, hashes));
		({generationId, mode} = begun);

		const report = commitAdapters({
			config: input.config,
			database: input.database,
			logger: input.logger,
			plans: scans,
			targets,
			generationId,
			mode,
			startedAt,
			startedAtIso,
			force: input.force,
			extractorOverride: input.extractor,
			ownerId: input.ownerId,
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
