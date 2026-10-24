import {setTimeout as delay} from 'node:timers/promises';
import {type IndexDatabase} from '../storage/database.ts';
import {type BuildReportType, type GenerationRowType} from '../model.ts';

/** Deadline for one external build wait, including expired-lease retries. */
export const EXTERNAL_BUILD_TIMEOUT_MS = 15_000;

const POLL_INTERVAL_MS = 150;

const reusedReport = (generation: GenerationRowType): BuildReportType => ({
	generationId: generation.id,
	state: 'published',
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
export type ExternalBuildObservationType = Readonly<{state: 'published'; report: BuildReportType}> | Readonly<{state: 'lease-expired'}>;

/** Outcome of claiming the build lease or observing another owner. */
export type BuildLeaseOutcomeType = Readonly<{state: 'acquired'}> | Readonly<{state: 'published'; report: BuildReportType}>;

/**
 * Waits for another process holding the build lease to publish.
 *
 * A reader never builds while another owner holds the lease. It observes the
 * externally published generation and returns as soon as that owner publishes.
 * An expired lease is returned to the caller so it can attempt takeover
 * immediately instead of waiting for the full deadline.
 *
 * @param input - Database, previously observed generation, deadline, and timing hooks.
 * @returns The observed publication or an expired-lease takeover signal.
 * @throws {@link Error} When no external publication appears before the deadline.
 */
export const observeExternalBuild = async (
	input: Readonly<{
		database: IndexDatabase;
		previous: GenerationRowType | null;
		startedAt: number;
		deadlineAt: number;
		record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	}>,
): Promise<ExternalBuildObservationType> => {
	const poll = async (): Promise<ExternalBuildObservationType> => {
		const published = input.database.getPublishedGeneration();

		if (published !== null && (input.previous === null || published.id !== input.previous.id)) {
			input.record?.('build_observed', {
				durationMs: Math.round(performance.now() - input.startedAt),
				generationChanged: true,
			});
			return {state: 'published', report: reusedReport(published)};
		}

		const now = Date.now();

		if (now >= input.deadlineAt) {
			throw new Error('Another process is building the index; retry after it publishes');
		}

		const lease = input.database.getBuildLease();

		if (lease !== null && now >= Date.parse(lease.expiresAt)) {
			return {state: 'lease-expired'};
		}

		await delay(POLL_INTERVAL_MS);
		return poll();
	};

	const observation = await poll();
	return observation;
};

/**
 * Claims the build lease or waits for its current owner.
 *
 * Takeover is retried as soon as the observed lease expires, so a dead owner
 * does not block another process until the full external-build deadline.
 *
 * @param input - Database, previous generation, lease attempt, deadline, and timing hooks.
 * @returns Whether this process acquired the lease or observed a publication.
 * @throws {@link Error} When a live owner does not publish before the deadline.
 */
export const acquireOrObserveBuildLease = async (
	input: Readonly<{
		database: IndexDatabase;
		previous: GenerationRowType | null;
		startedAt: number;
		deadlineAt: number;
		tryAcquire: () => boolean;
		record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	}>,
): Promise<BuildLeaseOutcomeType> => {
	if (input.tryAcquire()) {
		return {state: 'acquired'};
	}

	const observation = await observeExternalBuild({
		database: input.database,
		previous: input.previous,
		startedAt: input.startedAt,
		deadlineAt: input.deadlineAt,
		...(input.record === undefined ? {} : {record: input.record}),
	});

	if (observation.state === 'published') {
		return observation;
	}

	return acquireOrObserveBuildLease(input);
};
