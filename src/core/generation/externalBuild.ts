import {setTimeout as delay} from 'node:timers/promises';
import {type IndexDatabase} from '../storage/database.ts';
import {type BuildReportType, type GenerationRowType} from '../model.ts';
import {supersededReport} from './buildReports.ts';

const POLL_INTERVAL_MS = 150;

const reusedReport = (generation: GenerationRowType): BuildReportType => ({
	generationId: generation.id,
	revision: generation.revision,
	state: 'published',
	outcome: 'reused',
	reused: true,
	durationMs: 0,
	fileCount: generation.fileCount,
	symbolCount: generation.symbolCount,
	occurrenceCount: generation.occurrenceCount,
	dependencyEdgeCount: generation.dependencyEdgeCount,
	dependencyBindingCount: generation.dependencyBindingCount,
	diagnosticCount: generation.diagnosticCount,
	stages: null,
});

/** Outcome of waiting for another process to publish or lose its lease. */
export type ExternalBuildObservationType =
	| Readonly<{state: 'published'; report: BuildReportType}>
	| Readonly<{state: 'lease-expired'}>
	| Readonly<{state: 'cancelled'}>;

/** Outcome of claiming the build lease or observing another owner. */
export type BuildLeaseOutcomeType = Readonly<{state: 'acquired'}> | Readonly<{state: 'published'; report: BuildReportType}> | Readonly<{state: 'cancelled'}>;

type AdapterRevisionType = Readonly<{
	adapterId: string;
	revision: number | null;
}>;

/** Published state captured before waiting for another lease owner. */
export type ExternalBuildBaselineType = Readonly<{
	publication: GenerationRowType | null;
	adapterRevisions: readonly AdapterRevisionType[];
}>;

type BuildLeaseInputType = Readonly<{
	database: IndexDatabase;
	requestedAdapterIds: readonly string[];
	startedAt: number;
	signal?: AbortSignal;
	isCancelled?: () => boolean;
	tryAcquire: () => boolean;
	record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

type ContendedBuildLeaseInputType = Omit<BuildLeaseInputType, 'requestedAdapterIds'> & Readonly<{baseline: ExternalBuildBaselineType}>;

const publicationChanged = (previous: GenerationRowType | null, published: GenerationRowType): boolean =>
	previous === null || published.id !== previous.id || published.revision !== previous.revision;

const readExternalBuildState = (database: IndexDatabase, adapterIds: readonly string[]): ExternalBuildBaselineType =>
	database.readSnapshot(() => {
		const publication = database.getPublishedGeneration();
		const stored =
			publication === null
				? new Map<string, number>()
				: new Map(database.getGenerationAdapters(publication.id).map((adapter) => [adapter.adapterId, adapter.revision]));
		return {
			publication,
			adapterRevisions: adapterIds.map((adapterId) => ({adapterId, revision: stored.get(adapterId) ?? null})),
		};
	});

const requestedAdaptersAdvanced = (baseline: ExternalBuildBaselineType, observed: ExternalBuildBaselineType): boolean => {
	const published = observed.publication;

	if (published === null || !publicationChanged(baseline.publication, published)) {
		return false;
	}

	const observedById = new Map(observed.adapterRevisions.map((adapter) => [adapter.adapterId, adapter.revision]));
	const generationChanged = baseline.publication !== null && published.id !== baseline.publication.id;
	return baseline.adapterRevisions.every((adapter) => {
		const revision = observedById.get(adapter.adapterId);
		return revision !== undefined && revision !== null && (generationChanged || adapter.revision === null || revision > adapter.revision);
	});
};

const cancellationRequested = (signal: AbortSignal | undefined, isCancelled?: () => boolean): boolean => signal?.aborted === true || isCancelled?.() === true;

/**
 * Converts external observation outcomes into reports; acquisition continues locally.
 *
 * @param outcome - Lease acquisition or observation result.
 * @param database - Index database containing the current publication.
 * @param startedAt - Refresh start time in epoch milliseconds.
 * @returns A terminal external report, or null when this process acquired the lease.
 */
export const externalBuildReport = (outcome: BuildLeaseOutcomeType, database: IndexDatabase, startedAt: number): BuildReportType | null => {
	switch (outcome.state) {
		case 'acquired': {
			return null;
		}
		case 'published': {
			return outcome.report;
		}
		case 'cancelled': {
			const published = database.getPublishedGeneration();
			return supersededReport({generationId: published?.id ?? '', published, startedAt});
		}
		default: {
			throw new Error('Unknown build lease outcome');
		}
	}
};

/**
 * Waits for another process holding the build lease to publish.
 *
 * A reader never builds while another owner holds the lease. It observes the
 * externally published generation and returns only after every requested
 * adapter advances from the captured baseline.
 * An expired lease is returned to the caller so it can attempt takeover
 * immediately.
 *
 * @param input - Database, requested-adapter baseline, cancellation, and timing hooks.
 * @returns The observed publication, cancellation, or a lease takeover signal.
 */
export const observeExternalBuild = async (
	input: Readonly<{
		database: IndexDatabase;
		baseline: ExternalBuildBaselineType;
		startedAt: number;
		signal?: AbortSignal;
		isCancelled?: () => boolean;
		record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	}>,
): Promise<ExternalBuildObservationType> => {
	input.record?.('build_observation_started');
	const poll = async (): Promise<ExternalBuildObservationType> => {
		if (cancellationRequested(input.signal, input.isCancelled)) {
			input.record?.('build_observation_cancelled', {durationMs: Math.round(performance.now() - input.startedAt)});
			return {state: 'cancelled'};
		}

		const observed = readExternalBuildState(
			input.database,
			input.baseline.adapterRevisions.map((adapter) => adapter.adapterId),
		);
		const published = observed.publication;

		if (published !== null && requestedAdaptersAdvanced(input.baseline, observed)) {
			input.record?.('build_observed', {
				durationMs: Math.round(performance.now() - input.startedAt),
				generationChanged: true,
				adapterCount: input.baseline.adapterRevisions.length,
			});
			return {state: 'published', report: reusedReport(published)};
		}

		const now = Date.now();
		const lease = input.database.getBuildLease();

		if (lease === null || now >= Date.parse(lease.expiresAt)) {
			return {state: 'lease-expired'};
		}

		try {
			await (input.signal === undefined ? delay(POLL_INTERVAL_MS) : delay(POLL_INTERVAL_MS, undefined, {signal: input.signal}));
		} catch (error) {
			if (cancellationRequested(input.signal, input.isCancelled)) {
				input.record?.('build_observation_cancelled', {durationMs: Math.round(performance.now() - input.startedAt)});
				return {state: 'cancelled'};
			}

			throw error;
		}

		return poll();
	};

	const observation = await poll();
	return observation;
};

const retryAfterContention = async (input: ContendedBuildLeaseInputType): Promise<BuildLeaseOutcomeType> => {
	if (cancellationRequested(input.signal, input.isCancelled)) {
		return {state: 'cancelled'};
	}

	if (input.tryAcquire()) {
		input.record?.('build_takeover', {durationMs: Math.round(performance.now() - input.startedAt)});
		return {state: 'acquired'};
	}

	const observation = await observeExternalBuild({
		database: input.database,
		baseline: input.baseline,
		startedAt: input.startedAt,
		...(input.signal === undefined ? {} : {signal: input.signal}),
		...(input.isCancelled === undefined ? {} : {isCancelled: input.isCancelled}),
		...(input.record === undefined ? {} : {record: input.record}),
	});
	return observation.state === 'lease-expired' ? retryAfterContention(input) : observation;
};

/**
 * Claims the build lease or waits for its current owner.
 *
 * Takeover is retried as soon as the observed lease expires, so a dead owner
 * does not block another process beyond the lease lifetime.
 *
 * @param input - Database, requested adapter roster, lease attempt, cancellation, and timing hooks.
 * @returns Whether this process acquired the lease, observed a publication, or was cancelled.
 */
export const acquireOrObserveBuildLease = async (input: BuildLeaseInputType): Promise<BuildLeaseOutcomeType> => {
	if (cancellationRequested(input.signal, input.isCancelled)) {
		return {state: 'cancelled'};
	}

	const baseline = readExternalBuildState(input.database, input.requestedAdapterIds);

	if (input.tryAcquire()) {
		return {state: 'acquired'};
	}

	const observation = await observeExternalBuild({
		database: input.database,
		baseline,
		startedAt: input.startedAt,
		...(input.signal === undefined ? {} : {signal: input.signal}),
		...(input.isCancelled === undefined ? {} : {isCancelled: input.isCancelled}),
		...(input.record === undefined ? {} : {record: input.record}),
	});
	return observation.state === 'lease-expired' ? retryAfterContention({...input, baseline}) : observation;
};
