import {afterAll, describe, expect, it} from 'vitest';
import {collectStatus, type StatusInputType} from '../src/core/freshness/indexStatus.ts';
import {type RefreshCoordinatorSnapshotType} from '../src/core/freshness/refreshCoordinator.ts';
import {type GenerationRowType, type RefreshStateType} from '../src/core/model.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const generation = (overrides: Partial<GenerationRowType> = {}): GenerationRowType => ({
	id: 'generation',
	state: 'published',
	extractorId: 'typescript',
	extractorVersion: '1',
	compilerVersion: '5.0.0',
	sourceHash: 'source',
	configHash: 'config',
	startedAt: '2026-01-01T00:00:00.000Z',
	completedAt: '2026-01-01T00:00:02.000Z',
	fileCount: 1,
	symbolCount: 2,
	occurrenceCount: 3,
	dependencyEdgeCount: 4,
	dependencyBindingCount: 5,
	diagnosticCount: 6,
	stages: null,
	error: null,
	...overrides,
});

const refresh = (overrides: Partial<RefreshCoordinatorSnapshotType> = {}): RefreshCoordinatorSnapshotType => ({
	state: 'current',
	checkedAt: '2026-01-01T00:00:00.000Z',
	dirtyFileCount: null,
	projectWideInvalidation: false,
	refreshAgain: false,
	lastRefreshStartedAt: null,
	lastRefreshCompletedAt: null,
	lastError: null,
	lastReason: null,
	...overrides,
});

const fixture = createFixtureConfig('simple-project');
const database = IndexDatabase.open(':memory:');

const statusOf = (overrides: Partial<StatusInputType> = {}): ReturnType<typeof collectStatus> =>
	collectStatus({
		config: fixture.config,
		database,
		published: generation(),
		refresh: refresh(),
		workingCopyId: 'working-copy',
		lastError: null,
		...overrides,
	});

describe('index status', () => {
	afterAll(() => {
		database.close();
		fixture.cleanup();
	});

	it('maps every coordinator state to freshness', () => {
		const expected: readonly (readonly [RefreshStateType, string, boolean | null])[] = [
			['current', 'current', false],
			['dirty', 'updating', true],
			['building', 'updating', true],
			['failed', 'stale', true],
			['unknown', 'unknown', null],
			['stopping', 'unknown', true],
		];

		for (const [state, freshness, sourceChanged] of expected) {
			const status = statusOf({refresh: refresh({state, dirtyFileCount: state === 'dirty' ? 3 : null})});

			expect(status.freshness).toMatchObject({state: freshness, sourceChanged, staleFiles: state === 'dirty' ? 3 : 0});
		}
	});

	it('reports published generation details and build duration', () => {
		const status = statusOf({
			published: generation({
				stages: {scanMs: 1, compilerMs: 2, extractionMs: 3, insertionMs: 4, verificationMs: 5, publicationMs: 6},
			}),
		});

		expect(status).toMatchObject({
			ready: true,
			state: 'published',
			generationId: 'generation',
			scope: {
				extractor: {compilerVersion: '5.0.0'},
				workingCopyId: 'working-copy',
				projects: [{name: 'root', projectFile: fixture.config.projectFilePath}],
			},
			hashes: {source: 'source', configuration: 'config'},
			counts: {files: 1, symbols: 2, occurrences: 3, dependencyEdges: 4, dependencyBindings: 5, diagnostics: 6},
			build: {startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:02.000Z', durationMs: 2000},
		});
		expect(status.build.stages).toStrictEqual({scanMs: 1, compilerMs: 2, extractionMs: 3, insertionMs: 4, verificationMs: 5, publicationMs: 6});
	});

	it('reports absent and incomplete generations', () => {
		const absent = statusOf({published: null, refresh: refresh({state: 'building'}), lastError: 'startup failed'});

		expect(absent).toMatchObject({
			ready: false,
			state: 'building',
			refresh: 'building',
			building: true,
			generationId: null,
			hashes: {source: null, configuration: null},
			counts: {files: 0, symbols: 0, occurrences: 0, dependencyEdges: 0, dependencyBindings: 0, diagnostics: 0},
			build: {startedAt: null, completedAt: null, durationMs: null, stages: null},
			lastError: 'startup failed',
		});
		expect(absent.scope.extractor.compilerVersion).toBe('unknown');

		const incomplete = statusOf({published: generation({completedAt: null})});

		expect(incomplete.build.durationMs).toBeNull();
	});

	it('prefers the coordinator error over the retained error', () => {
		expect(statusOf({refresh: refresh({lastError: 'refresh failed'}), lastError: 'retained'}).lastError).toBe('refresh failed');
		expect(statusOf({refresh: refresh(), lastError: 'retained'}).lastError).toBe('retained');
	});
});
