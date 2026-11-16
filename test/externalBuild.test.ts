import {afterEach, describe, expect, it, vi} from 'vitest';
import {acquireOrObserveBuildLease, observeExternalBuild, type ExternalBuildBaselineType} from '../src/core/generation/externalBuild.ts';
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

type AdapterRevisionRowType = Readonly<{adapterId: string; revision: number; coverage?: 'present' | 'absent'}>;

const databaseOf = (
	published: GenerationRowType | null,
	leaseExpiresAt: string | null = null,
	adapterRevisions: readonly AdapterRevisionRowType[] = published === null ? [] : [{adapterId: 'typescript', revision: published.revision}],
): IndexDatabase =>
	({
		readSnapshot: <ValueType>(action: () => ValueType): ValueType => action(),
		getPublishedGeneration: () => published,
		getGenerationAdapters: () => adapterRevisions,
		getBuildLease: () => (leaseExpiresAt === null ? null : ({expiresAt: leaseExpiresAt} as BuildLeaseType)),
	}) as unknown as IndexDatabase;

type MutablePublicationType = {
	published: GenerationRowType;
	adapterRevisions: AdapterRevisionRowType[];
};

const liveDatabaseOf = (state: MutablePublicationType): IndexDatabase =>
	({
		readSnapshot: <ValueType>(action: () => ValueType): ValueType => action(),
		getPublishedGeneration: () => state.published,
		getGenerationAdapters: () => state.adapterRevisions,
		getBuildLease: () => ({expiresAt: new Date(Date.now() + 1000).toISOString()}),
	}) as unknown as IndexDatabase;

type ObservationInputType = Readonly<{
	database: IndexDatabase;
	baseline: ExternalBuildBaselineType;
	startedAt: number;
	signal?: AbortSignal;
}>;

const observationInput = (
	input: Readonly<{published: GenerationRowType | null; previous: GenerationRowType | null; leaseExpiresAt?: string | null}>,
): ObservationInputType => ({
	database: databaseOf(input.published, input.leaseExpiresAt ?? null),
	baseline: {
		publication: input.previous,
		adapterRevisions: [{adapterId: 'typescript', revision: input.previous?.revision ?? null}],
	},
	startedAt: 0,
});

describe('external build publication observation', () => {
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
});

describe('external build adapter scope observation', () => {
	it('does not complete an Oracle wait when only TypeScript publishes', async () => {
		const previous = generation('same', 1);
		const input = {
			database: {
				readSnapshot: <ValueType>(action: () => ValueType): ValueType => action(),
				getPublishedGeneration: () => generation('same', 2),
				getGenerationAdapters: () => [
					{adapterId: 'oracle', revision: 1},
					{adapterId: 'typescript', revision: 2},
				],
				getBuildLease: () => null,
			} as unknown as IndexDatabase,
			baseline: {publication: previous, adapterRevisions: [{adapterId: 'oracle', revision: 1}]},
			startedAt: 0,
		};

		await expect(observeExternalBuild(input)).resolves.toStrictEqual({state: 'lease-expired'});
	});

	it('does not complete a TypeScript wait when only Oracle publishes', async () => {
		const previous = generation('same', 1);
		const observed = observeExternalBuild({
			database: databaseOf(generation('same', 2), null, [
				{adapterId: 'oracle', revision: 2},
				{adapterId: 'typescript', revision: 1},
			]),
			baseline: {publication: previous, adapterRevisions: [{adapterId: 'typescript', revision: 1}]},
			startedAt: 0,
		});

		await expect(observed).resolves.toStrictEqual({state: 'lease-expired'});
	});
});

describe('external build adapter barrier observation', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('continues after an unrelated scoped publication until the requested adapter publishes', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same', 1);
		const state: MutablePublicationType = {
			published: previous,
			adapterRevisions: [
				{adapterId: 'oracle', revision: 1},
				{adapterId: 'typescript', revision: 1},
			],
		};
		const observed = observeExternalBuild({
			database: liveDatabaseOf(state),
			baseline: {publication: previous, adapterRevisions: [{adapterId: 'oracle', revision: 1}]},
			startedAt: 0,
		});

		state.published = generation('same', 2);
		state.adapterRevisions = [
			{adapterId: 'oracle', revision: 1},
			{adapterId: 'typescript', revision: 2},
		];
		await vi.advanceTimersByTimeAsync(151);
		await expect(Promise.race([observed, Promise.resolve('pending')])).resolves.toBe('pending');

		state.published = generation('same', 3);
		state.adapterRevisions = [
			{adapterId: 'oracle', revision: 2},
			{adapterId: 'typescript', revision: 2},
		];
		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toMatchObject({state: 'published', report: {revision: 3}});
	});

	it('requires every adapter in a full-request roster to advance', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same', 1);
		const state: MutablePublicationType = {
			published: previous,
			adapterRevisions: [
				{adapterId: 'oracle', revision: 1},
				{adapterId: 'typescript', revision: 1},
			],
		};
		const observed = observeExternalBuild({
			database: liveDatabaseOf(state),
			baseline: {
				publication: previous,
				adapterRevisions: [
					{adapterId: 'oracle', revision: 1},
					{adapterId: 'typescript', revision: 1},
				],
			},
			startedAt: 0,
		});

		state.published = generation('same', 2);
		state.adapterRevisions = [
			{adapterId: 'oracle', revision: 1},
			{adapterId: 'typescript', revision: 2},
		];
		await vi.advanceTimersByTimeAsync(151);
		await expect(Promise.race([observed, Promise.resolve('pending')])).resolves.toBe('pending');

		state.published = generation('same', 3);
		state.adapterRevisions = [
			{adapterId: 'oracle', revision: 2},
			{adapterId: 'typescript', revision: 2},
		];
		await vi.advanceTimersByTimeAsync(151);

		await expect(observed).resolves.toMatchObject({state: 'published', report: {revision: 3}});
	});
});

describe('external build adapter roster observation', () => {
	it('rejects an incomplete roster and accepts a newly published absent adapter row', async () => {
		const previous = generation('same', 1);
		const baseline: ExternalBuildBaselineType = {
			publication: previous,
			adapterRevisions: [
				{adapterId: 'oracle', revision: 1},
				{adapterId: 'typescript', revision: 1},
			],
		};
		const incomplete = observeExternalBuild({
			database: databaseOf(generation('same', 2), null, [{adapterId: 'typescript', revision: 2}]),
			baseline,
			startedAt: 0,
		});

		await expect(incomplete).resolves.toStrictEqual({state: 'lease-expired'});

		const addedAbsent = observeExternalBuild({
			database: databaseOf(generation('same', 2), null, [{adapterId: 'oracle', revision: 1, coverage: 'absent'}]),
			baseline: {publication: previous, adapterRevisions: [{adapterId: 'oracle', revision: null}]},
			startedAt: 0,
		});
		await expect(addedAbsent).resolves.toMatchObject({state: 'published', report: {revision: 2}});
	});
});

describe('external build observation snapshots', () => {
	it('reads the publication and adapter revisions inside one snapshot', async () => {
		const previous = generation('same', 1);
		let insideSnapshot = false;
		let snapshotCount = 0;
		const observed = observeExternalBuild({
			database: {
				readSnapshot: <ValueType>(action: () => ValueType): ValueType => {
					snapshotCount += 1;
					insideSnapshot = true;
					try {
						return action();
					} finally {
						insideSnapshot = false;
					}
				},
				getPublishedGeneration: () => {
					expect(insideSnapshot).toBe(true);
					return generation('same', 2);
				},
				getGenerationAdapters: () => {
					expect(insideSnapshot).toBe(true);
					return [{adapterId: 'typescript', revision: 2}];
				},
				getBuildLease: () => null,
			} as unknown as IndexDatabase,
			baseline: {publication: previous, adapterRevisions: [{adapterId: 'typescript', revision: 1}]},
			startedAt: 0,
		});

		await expect(observed).resolves.toMatchObject({state: 'published', report: {revision: 2}});
		expect(snapshotCount).toBe(1);
	});
});

describe('external build observation lifecycle', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('continues beyond fifteen seconds while the lease remains live', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		let published = previous;
		const observed = observeExternalBuild({
			...observationInput({published: previous, previous}),
			database: {
				readSnapshot: <ValueType>(action: () => ValueType): ValueType => action(),
				getPublishedGeneration: () => published,
				getGenerationAdapters: () => [{adapterId: 'typescript', revision: published.revision}],
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
				readSnapshot: <ValueType>(action: () => ValueType): ValueType => action(),
				getPublishedGeneration: () => previous,
				getGenerationAdapters: () => [{adapterId: 'typescript', revision: previous.revision}],
				getBuildLease: () => ({expiresAt: new Date(100).toISOString()}),
			} as unknown as IndexDatabase,
			requestedAdapterIds: ['typescript'],
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
});

describe('external build lease publication', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('takes over for local re-evaluation after only an unrelated adapter advanced', async () => {
		const previous = generation('same', 1);
		let snapshot = 0;
		let attempts = 0;
		const observed = acquireOrObserveBuildLease({
			database: {
				readSnapshot: <ValueType>(action: () => ValueType): ValueType => {
					snapshot += 1;
					return action();
				},
				getPublishedGeneration: () => (snapshot === 1 ? previous : generation('same', 2)),
				getGenerationAdapters: () =>
					snapshot === 1
						? [
								{adapterId: 'oracle', revision: 1},
								{adapterId: 'typescript', revision: 1},
							]
						: [
								{adapterId: 'oracle', revision: 1},
								{adapterId: 'typescript', revision: 2},
							],
				getBuildLease: () => null,
			} as unknown as IndexDatabase,
			requestedAdapterIds: ['oracle'],
			startedAt: 0,
			tryAcquire: () => {
				attempts += 1;
				return attempts === 2;
			},
		});

		await expect(observed).resolves.toStrictEqual({state: 'acquired'});
		expect(attempts).toBe(2);
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
				readSnapshot: <ValueType>(action: () => ValueType): ValueType => action(),
				getPublishedGeneration: () => published,
				getGenerationAdapters: () => [{adapterId: 'typescript', revision: published.revision}],
				getBuildLease: () => {
					leaseReads += 1;
					return {expiresAt: new Date(leaseReads === 1 ? -1 : 10_000).toISOString()};
				},
			} as unknown as IndexDatabase,
			requestedAdapterIds: ['typescript'],
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
