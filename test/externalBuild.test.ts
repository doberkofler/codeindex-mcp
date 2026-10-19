import {afterEach, describe, expect, it, vi} from 'vitest';
import {observeExternalBuild} from '../src/core/generation/externalBuild.ts';
import {type GenerationRowType} from '../src/core/model.ts';
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
	fileCount: 1,
	symbolCount: 2,
	occurrenceCount: 3,
	dependencyEdgeCount: 4,
	dependencyBindingCount: 5,
	diagnosticCount: 6,
	stages: null,
	error: null,
});

const databaseOf = (published: GenerationRowType | null): IndexDatabase => ({getPublishedGeneration: () => published}) as unknown as IndexDatabase;

describe('external build observation', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('reports an externally published generation', async () => {
		const events: string[] = [];
		const report = await observeExternalBuild({
			database: databaseOf(generation('external')),
			previous: null,
			startedAt: performance.now(),
			record: (event) => {
				events.push(event);
			},
		});

		expect(report).toMatchObject({generationId: 'external', reused: true, durationMs: 0, fileCount: 1, diagnosticCount: 6});
		expect(events).toStrictEqual(['build_observed']);
	});

	it('rejects an unchanged generation after the deadline', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previous = generation('same');
		const observed = observeExternalBuild({database: databaseOf(previous), previous, startedAt: 0});

		await vi.advanceTimersByTimeAsync(15_001);

		await expect(observed).rejects.toThrow(/Another process is building the index/u);
	});
});
