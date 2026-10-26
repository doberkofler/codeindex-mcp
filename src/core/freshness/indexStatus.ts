import {type ConfigType} from '../config/config.ts';
import {extractorFor} from '../../adapters/registry.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {type BuildLeaseType, type GenerationRowType, type IndexStatusSummaryType, type IndexStatusType, type QueryFreshnessType} from '../model.ts';
import {type RefreshCoordinatorSnapshotType} from './refreshCoordinator.ts';

const CORE_EXCLUSIONS: readonly string[] = [
	'files outside the configured extractor projects are not indexed',
	'cross-language edges are not indexed',
	'no fuzzy search, embeddings, or full-text search',
];

export type StatusInputType = Readonly<{
	config: ConfigType;
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

const buildOf = (published: GenerationRowType | null): IndexStatusType['build'] => ({
	startedAt: published?.startedAt ?? null,
	completedAt: published?.completedAt ?? null,
	durationMs: published?.completedAt === null || published === null ? null : Date.parse(published.completedAt) - Date.parse(published.startedAt),
	stages: published?.stages ?? null,
});

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

	return {
		ready: published !== null,
		state: refresh.state === 'building' ? 'building' : (published?.state ?? 'absent'),
		refresh: refresh.state,
		generationId: published?.id ?? null,
		revision: published?.revision ?? null,
		building: refresh.state === 'building',
		scope: {
			root: input.config.rootDir,
			projectName: input.config.projectName,
			projectFile: input.config.projectFilePath,
			projects: input.config.projects.map((project) => ({name: project.name, projectFile: project.projectFilePath})),
			extractor: {
				id: input.config.extractorId,
				version: extractorFor(input.config.extractorId).version,
				compilerVersion: published?.compilerVersion ?? 'unknown',
			},
			projectId: input.config.projectId,
			workingCopyId: input.workingCopyId,
		},
		hashes: hashesOf(published),
		counts: countsOf(published),
		buildStats: published === null ? [] : input.database.listBuildStats(published.id),
		build: buildOf(published),
		freshness: freshnessOf(refresh),
		lease,
		exclusions: [...CORE_EXCLUSIONS, ...extractorFor(input.config.extractorId).limitations],
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
export const summaryStatusOf = (status: IndexStatusType): IndexStatusSummaryType => ({
	ready: status.ready,
	state: status.state,
	refresh: status.refresh,
	generationId: status.generationId,
	revision: status.revision,
	building: status.building,
	scope: {
		projectName: status.scope.projectName,
		contexts: status.scope.projects.map((project) => project.name),
		extractor: status.scope.extractor,
	},
	counts: status.counts,
	freshness: status.freshness,
	lastError: status.lastError,
});
