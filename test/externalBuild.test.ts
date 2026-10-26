import {afterEach, describe, expect, it, vi} from 'vitest';
import {acquireOrObserveBuildLease, observeExternalBuild} from '../src/core/generation/externalBuild.ts';
import {type BuildLeaseType, type GenerationRowType} from '../src/core/model.ts';
import {type IndexDatabase} from '../src/core/storage/database.ts';

const generation = (id: string): GenerationRowType => ({
	id,
	state: 'published',
	extractorId: 'typescript',
	extractorVersion: '1',
	compilerVersion: '1',
	sourceHash: 'source',
	configHash: 'config',
	startedAt: '2026-01-01T00:00:00.000Z',
	completedAt: '2026-01-01T00:00:01.000Z',
	revision: 1,
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
	deadlineAt: number;
}>;

const observationInput = (
	input: Readonly<{published: GenerationRowType | null; previous: GenerationRowType | null; leaseExpiresAt?: string | null}>,
): ObservationInputType => ({
	database: databaseOf(input.published, input.leaseExpiresAt ?? null),
	previous: input.previous,
	startedAt: 0,
	deadlineAt: 15_000,
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
		expect(events).toStrictEqual(['build_observed']);
	});

	it('rejects an unchanged generation after the deadline', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		const observed = observeExternalBuild(observationInput({published: previous, previous}));

		await vi.advanceTimersByTimeAsync(15_001);

		await expect(observed).rejects.toThrow(/Another process is building the index/u);
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
		const observed = acquireOrObserveBuildLease({
			database: {
				getPublishedGeneration: () => previous,
				getBuildLease: () => ({expiresAt: new Date(100).toISOString()}),
			} as unknown as IndexDatabase,
			previous,
			startedAt: 0,
			deadlineAt: 15_000,
			tryAcquire: () => {
				attempts += 1;
				return attempts > 1;
			},
		});

		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toStrictEqual({state: 'acquired'});
		expect(attempts).toBe(2);
	});
});
