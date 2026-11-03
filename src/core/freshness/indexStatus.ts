import {type AdapterType} from '@codeindex/adapter-sdk';
import {type ConfigType, configuredAdapters} from '../config/config.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {
	type BuildLeaseType,
	type GenerationAdapterType,
	type GenerationRowType,
	type IndexStatusSummaryType,
	type IndexStatusType,
	type QueryFreshnessType,
} from '../model.ts';
import {type RefreshCoordinatorSnapshotType} from './refreshCoordinator.ts';

const CORE_EXCLUSIONS: readonly string[] = [
	'files outside the configured extractor projects are not indexed',
	'cross-language edges are not indexed',
	'no fuzzy search, embeddings, or full-text search',
];

export type StatusInputType = Readonly<{
	config: ConfigType;
	adapters: ReadonlyMap<string, AdapterType>;
	database: IndexDatabase;
	published: GenerationRowType | null;
	refresh: RefreshCoordinatorSnapshotType;
	workingCopyId: string | null;
	lastError: string | null;
}>;

const countsOf = (published: GenerationRowType | null): IndexStatusType['counts'] => ({
	files: published?.fileCount ?? 0,
	symbols: published?.symbolCount ?? 0,
	occurrences: published?.occurrenceCount ?? 0,
	dependencyEdges: published?.dependencyEdgeCount ?? 0,
	dependencyBindings: published?.dependencyBindingCount ?? 0,
	diagnostics: published?.diagnosticCount ?? 0,
});

const hashesOf = (published: GenerationRowType | null): IndexStatusType['hashes'] => ({
	source: published?.sourceHash ?? null,
	configuration: published?.configHash ?? null,
});

const buildOf = (published: GenerationRowType | null): IndexStatusType['build'] => {
	const measured = published?.completedAt === null || published === null ? null : Date.parse(published.completedAt) - Date.parse(published.startedAt);
	const stageTotal = published?.stages === null || published === null ? 0 : Object.values(published.stages).reduce((total, value) => total + value, 0);

	return {
		startedAt: published?.startedAt ?? null,
		completedAt: published?.completedAt ?? null,
		durationMs: measured === null ? null : Math.max(measured, stageTotal),
		stages: published?.stages ?? null,
	};
};

const stateOf = (refresh: RefreshCoordinatorSnapshotType, published: GenerationRowType | null): IndexStatusType['state'] =>
	refresh.state === 'building' ? 'building' : (published?.state ?? 'absent');

const compilerProvenanceOf = (
	row: GenerationAdapterType | undefined,
	projection: GenerationRowType | null,
): Readonly<{compilerVersion: string; declaredCompilerVersion: string | null; compilerDrift: boolean}> => ({
	compilerVersion: row?.compilerVersion ?? projection?.compilerVersion ?? 'unknown',
	declaredCompilerVersion: row?.declaredCompilerVersion ?? projection?.declaredCompilerVersion ?? null,
	compilerDrift: row?.compilerDrift ?? projection?.compilerDrift ?? false,
});

const missingCoverageReason = (published: GenerationRowType | null): string =>
	published === null ? 'no published generation' : 'adapter is not recorded in the published generation';

type AdapterStatusInputType = Readonly<{
	adapter: ReturnType<typeof configuredAdapters>[number];
	index: number;
	stored: ReadonlyMap<string, GenerationAdapterType>;
	published: GenerationRowType | null;
	loaded: ReadonlyMap<string, AdapterType>;
}>;

const adapterStatusEntry = (input: AdapterStatusInputType): IndexStatusType['scope']['adapters'][number] => {
	const {adapter, index, stored, published, loaded} = input;
	const row = stored.get(adapter.id);
	const extractor = loaded.get(adapter.id);
	const projection = row === undefined && index === 0 && published !== null ? published : null;

	return {
		id: adapter.id,
		version: row?.adapterVersion ?? extractor?.version ?? 'unknown',
		coverage: row?.coverage ?? 'absent',
		absenceReason: row?.absenceReason ?? missingCoverageReason(published),
		...compilerProvenanceOf(row, projection),
		contexts: adapter.projects.map((project) => project.name),
		limitations: extractor?.limitations ?? [],
	};
};

const adapterStatusOf = (
	config: ConfigType,
	published: GenerationRowType | null,
	database: IndexDatabase,
	loaded: ReadonlyMap<string, AdapterType>,
): IndexStatusType['scope']['adapters'] => {
	const stored = new Map<string, GenerationAdapterType>(
		(published === null ? [] : database.getGenerationAdapters(published.id)).map((adapter) => [adapter.adapterId, adapter]),
	);

	return configuredAdapters(config).map((adapter, index) => adapterStatusEntry({adapter, index, stored, published, loaded}));
};

const extractorStatusOf = (adapters: IndexStatusType['scope']['adapters']): NonNullable<IndexStatusType['scope']['extractor']> => {
	const [primary] = adapters;

	return {
		id: primary?.id ?? 'unknown',
		version: primary?.version ?? 'unknown',
		compilerVersion: primary?.compilerVersion ?? 'unknown',
		declaredCompilerVersion: primary?.declaredCompilerVersion ?? null,
		compilerDrift: primary?.compilerDrift ?? false,
	};
};

/**
 * Projects the singular extractor only when exactly one adapter is configured.
 *
 * A multi-adapter workspace must read the adapter list; presenting one adapter
 * as the workspace summary would attribute its identity to the others.
 *
 * @param adapters - Configured adapter statuses.
 * @returns The singular projection, or undefined for a multi-adapter workspace.
 */
const singularExtractorOf = (adapters: IndexStatusType['scope']['adapters']): IndexStatusType['scope']['extractor'] | undefined =>
	adapters.length === 1 ? extractorStatusOf(adapters) : undefined;

const freshnessOf = (refresh: RefreshCoordinatorSnapshotType): IndexStatusType['freshness'] => {
	const state: QueryFreshnessType['state'] =
		refresh.state === 'current'
			? 'current'
			: refresh.state === 'dirty' || refresh.state === 'building'
				? 'updating'
				: refresh.state === 'failed'
					? 'stale'
					: 'unknown';

	return {
		state,
		checkedAt: refresh.checkedAt,
		dirtyFileCount: refresh.dirtyFileCount,
		staleFiles: refresh.dirtyFileCount ?? 0,
		sourceChanged: refresh.state === 'unknown' ? null : refresh.state !== 'current',
	};
};

/**
 * Collects status from the published generation and coordinator snapshot.
 *
 * Status never scans the workspace. Freshness is maintained by the watcher and
 * reconciliation, which keeps the query path independent of project size.
 *
 * @param input - Published generation, coordinator snapshot, and identity.
 * @returns The MCP status payload.
 */
export const collectStatus = (input: StatusInputType): IndexStatusType => {
	const {published, refresh} = input;
	const lease: BuildLeaseType | null = input.database.getBuildLease();
	const adapters = adapterStatusOf(input.config, published, input.database, input.adapters);
	const extractor = singularExtractorOf(adapters);

	return {
		ready: published !== null,
		state: stateOf(refresh, published),
		refresh: refresh.state,
		generationId: published?.id ?? null,
		revision: published?.revision ?? null,
		building: refresh.state === 'building',
		scope: {
			root: input.config.rootDir,
			projectName: input.config.projectName,
			projectFile: input.config.projectFilePath,
			projects: configuredAdapters(input.config).flatMap((adapter) =>
				adapter.projects.map((project) => ({name: project.name, projectFile: project.projectFilePath, adapter: adapter.id})),
			),
			adapters,
			...(extractor === undefined ? {} : {extractor}),
			projectId: input.config.projectId,
			workingCopyId: input.workingCopyId,
		},
		hashes: hashesOf(published),
		counts: countsOf(published),
		buildStats: published === null ? [] : input.database.listBuildStats(published.id),
		build: buildOf(published),
		freshness: freshnessOf(refresh),
		lease,
		exclusions: [...CORE_EXCLUSIONS, ...adapters.flatMap((adapter) => adapter.limitations)],
		lastError: refresh.lastError ?? input.lastError,
	};
};

/**
 * Projects status onto the bounded default response.
 *
 * The summary keeps readiness, freshness, counts, the configured project
 * contexts, and the retained error. Hashes, build statistics, build stages,
 * the lease, and exclusions stay available through `detail: full` so the
 * default response fits the 600-byte status budget.
 *
 * @param status - Complete status payload.
 * @returns The compact status payload.
 */
export const summaryStatusOf = (status: IndexStatusType): IndexStatusSummaryType => {
	const extractor = status.scope.adapters.length === 1 ? status.scope.extractor : undefined;
	const needsAdapterList = status.scope.adapters.length > 1 || (status.ready && status.scope.adapters.some((adapter) => adapter.coverage === 'absent'));

	return {
		ready: status.ready,
		state: status.state,
		refresh: status.refresh,
		generationId: status.generationId,
		revision: status.revision,
		building: status.building,
		scope: {
			projectName: status.scope.projectName,
			contexts: [...new Set(status.scope.projects.map((project) => project.name))],
			...(needsAdapterList
				? {
						adapters: status.scope.adapters.map((adapter) => ({
							id: adapter.id,
							coverage: adapter.coverage,
							...(adapter.absenceReason === null ? {} : {absenceReason: adapter.absenceReason}),
							contexts: adapter.contexts,
						})),
					}
				: {}),
			...(extractor === undefined ? {} : {extractor}),
		},
		counts: status.counts,
		freshness: status.freshness,
		lastError: status.lastError,
	};
};
