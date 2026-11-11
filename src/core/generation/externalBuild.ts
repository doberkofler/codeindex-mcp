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

type BuildLeaseInputType = Readonly<{
	database: IndexDatabase;
	previous: GenerationRowType | null;
	startedAt: number;
	signal?: AbortSignal;
	tryAcquire: () => boolean;
	record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

const publicationChanged = (previous: GenerationRowType | null, published: GenerationRowType): boolean =>
	previous === null || published.id !== previous.id || published.revision !== previous.revision;

const cancellationRequested = (signal: AbortSignal | undefined): boolean => signal?.aborted ?? false;

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
 * externally published generation and returns as soon as that owner publishes.
 * An expired lease is returned to the caller so it can attempt takeover
 * immediately.
 *
 * @param input - Database, previously observed generation, cancellation, and timing hooks.
 * @returns The observed publication, cancellation, or a lease takeover signal.
 */
export const observeExternalBuild = async (
	input: Readonly<{
		database: IndexDatabase;
		previous: GenerationRowType | null;
		startedAt: number;
		signal?: AbortSignal;
		record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	}>,
): Promise<ExternalBuildObservationType> => {
	input.record?.('build_observation_started');
	const poll = async (): Promise<ExternalBuildObservationType> => {
		if (cancellationRequested(input.signal)) {
			input.record?.('build_observation_cancelled', {durationMs: Math.round(performance.now() - input.startedAt)});
			return {state: 'cancelled'};
		}

		const published = input.database.getPublishedGeneration();

		if (published !== null && publicationChanged(input.previous, published)) {
			input.record?.('build_observed', {
				durationMs: Math.round(performance.now() - input.startedAt),
				generationChanged: true,
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
			if (cancellationRequested(input.signal)) {
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

const retryAfterContention = async (input: BuildLeaseInputType): Promise<BuildLeaseOutcomeType> => {
	if (cancellationRequested(input.signal)) {
		return {state: 'cancelled'};
	}

	if (input.tryAcquire()) {
		input.record?.('build_takeover', {durationMs: Math.round(performance.now() - input.startedAt)});
		return {state: 'acquired'};
	}

	const observation = await observeExternalBuild({
		database: input.database,
		previous: input.previous,
		startedAt: input.startedAt,
		...(input.signal === undefined ? {} : {signal: input.signal}),
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
 * @param input - Database, previous generation, lease attempt, cancellation, and timing hooks.
 * @returns Whether this process acquired the lease, observed a publication, or was cancelled.
 */
export const acquireOrObserveBuildLease = async (input: BuildLeaseInputType): Promise<BuildLeaseOutcomeType> => {
	if (cancellationRequested(input.signal)) {
		return {state: 'cancelled'};
	}

	if (input.tryAcquire()) {
		return {state: 'acquired'};
	}

	const observation = await observeExternalBuild({
		database: input.database,
		previous: input.previous,
		startedAt: input.startedAt,
		...(input.signal === undefined ? {} : {signal: input.signal}),
		...(input.record === undefined ? {} : {record: input.record}),
	});
	return observation.state === 'lease-expired' ? retryAfterContention(input) : observation;
};
