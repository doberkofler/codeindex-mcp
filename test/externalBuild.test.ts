import {afterEach, describe, expect, it, vi} from 'vitest';
import {acquireOrObserveBuildLease, observeExternalBuild} from '../src/core/generation/externalBuild.ts';
import {type BuildLeaseType, type GenerationRowType} from '../src/core/model.ts';
import {type IndexDatabase} from '../src/core/storage/database.ts';

const generation = (id: string, revision = 1): GenerationRowType => ({
	id,
	state: 'published',
	sourceHash: 'source',
	configHash: 'config',
	startedAt: '2026-01-01T00:00:00.000Z',
	completedAt: '2026-01-01T00:00:01.000Z',
	revision,
	fileCount: 1,
	symbolCount: 2,
	occurrenceCount: 3,
	dependencyEdgeCount: 4,
	dependencyBindingCount: 5,
	diagnosticCount: 6,
	stages: null,
	error: null,
});

const databaseOf = (published: GenerationRowType | null, leaseExpiresAt: string | null = null): IndexDatabase =>
	({
		getPublishedGeneration: () => published,
		getBuildLease: () => (leaseExpiresAt === null ? null : ({expiresAt: leaseExpiresAt} as BuildLeaseType)),
	}) as unknown as IndexDatabase;

type ObservationInputType = Readonly<{
	database: IndexDatabase;
	previous: GenerationRowType | null;
	startedAt: number;
	signal?: AbortSignal;
}>;

const observationInput = (
	input: Readonly<{published: GenerationRowType | null; previous: GenerationRowType | null; leaseExpiresAt?: string | null}>,
): ObservationInputType => ({
	database: databaseOf(input.published, input.leaseExpiresAt ?? null),
	previous: input.previous,
	startedAt: 0,
});

describe('external build observation', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('reports an externally published generation', async () => {
		const events: string[] = [];
		const observed = await observeExternalBuild({
			...observationInput({published: generation('external'), previous: null}),
			record: (event) => {
				events.push(event);
			},
		});

		expect(observed).toStrictEqual({
			state: 'published',
			report: {
				generationId: 'external',
				revision: 1,
				state: 'published',
				outcome: 'reused',
				reused: true,
				durationMs: 0,
				fileCount: 1,
				symbolCount: 2,
				occurrenceCount: 3,
				dependencyEdgeCount: 4,
				dependencyBindingCount: 5,
				diagnosticCount: 6,
				stages: null,
			},
		});
		expect(events).toStrictEqual(['build_observation_started', 'build_observed']);
	});

	it('reports an in-place publication with the same generation ID and a higher revision', async () => {
		const previous = generation('same', 1);
		const observed = await observeExternalBuild(observationInput({published: generation('same', 2), previous}));

		expect(observed).toMatchObject({state: 'published', report: {generationId: 'same', revision: 2}});
	});

	it('continues beyond fifteen seconds while the lease remains live', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		let published = previous;
		const observed = observeExternalBuild({
			...observationInput({published: previous, previous}),
			database: {
				getPublishedGeneration: () => published,
				getBuildLease: () => ({expiresAt: new Date(Date.now() + 1000).toISOString()}),
			} as unknown as IndexDatabase,
		});

		await vi.advanceTimersByTimeAsync(15_001);
		published = generation('same', 2);
		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toMatchObject({state: 'published', report: {revision: 2}});
	});

	it('returns a missing lease for immediate acquisition retry', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		const observed = observeExternalBuild(observationInput({published: previous, previous}));

		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toStrictEqual({state: 'lease-expired'});
	});

	it('returns cancellation without waiting for another poll', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const controller = new AbortController();
		const previous = generation('same');
		const observed = observeExternalBuild({
			...observationInput({published: previous, previous, leaseExpiresAt: new Date(10_000).toISOString()}),
			signal: controller.signal,
		});

		controller.abort();
		await vi.advanceTimersByTimeAsync(1);

		await expect(observed).resolves.toStrictEqual({state: 'cancelled'});
	});
});

describe('external build lease acquisition', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns an expired lease for immediate takeover', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		const observed = observeExternalBuild(observationInput({published: previous, previous, leaseExpiresAt: new Date(100).toISOString()}));

		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toStrictEqual({state: 'lease-expired'});
	});

	it('retries acquisition after the observed lease expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		let attempts = 0;
		const events: string[] = [];
		const observed = acquireOrObserveBuildLease({
			database: {
				getPublishedGeneration: () => previous,
				getBuildLease: () => ({expiresAt: new Date(100).toISOString()}),
			} as unknown as IndexDatabase,
			previous,
			startedAt: 0,
			tryAcquire: () => {
				attempts += 1;
				return attempts > 1;
			},
			record: (event) => {
				events.push(event);
			},
		});

		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toStrictEqual({state: 'acquired'});
		expect(attempts).toBe(2);
		expect(events.filter((event) => event === 'build_takeover')).toStrictEqual(['build_takeover']);
	});

	it('observes a replacement owner publication instead of extracting twice', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		let published = previous;
		let attempts = 0;
		let leaseReads = 0;
		const observed = acquireOrObserveBuildLease({
			database: {
				getPublishedGeneration: () => published,
				getBuildLease: () => {
					leaseReads += 1;
					return {expiresAt: new Date(leaseReads === 1 ? -1 : 10_000).toISOString()};
				},
			} as unknown as IndexDatabase,
			previous,
			startedAt: 0,
			tryAcquire: () => {
				attempts += 1;
				return false;
			},
		});

		published = generation('same', 2);
		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toMatchObject({state: 'published', report: {revision: 2}});
		expect(attempts).toBe(2);
	});
});
