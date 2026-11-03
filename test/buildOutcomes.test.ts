import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {buildTypeScriptFacts, scanTypeScriptProject, typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {type ExtractorType} from '../src/adapters/types.ts';
import {type AnalyticsRecorderType} from '../src/core/analytics/recorder.ts';
import {buildGeneration} from '../src/core/generation/buildGeneration.ts';
import {createCodeIndex, type CodeIndex} from '../src/core/generation/codeIndex.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {adapterSetOf} from './helpers/adapters.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';

const {join} = path;

const openDatabase = (config: ReturnType<typeof createFixtureConfig>['config']): IndexDatabase =>
	IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		projectId: config.projectId,
		extractorId: config.extractorId,
	});

const driftingExtractor = (shouldDrift: () => boolean): ExtractorType => ({
	...typeScriptExtractor,
	build: (config, scan, _cache) => {
		const facts = buildTypeScriptFacts(config, scan);

		return shouldDrift()
			? {
					...facts,
					validate: (): void => {
						throw new Error('TypeScript input changed during build: src/models.ts');
					},
				}
			: facts;
	},
});

const recordingAnalytics = (events: {event: string; fields: Readonly<Record<string, unknown>> | undefined}[]): AnalyticsRecorderType => ({
	enabled: true,
	path: '',
	record: (event, fields) => {
		events.push({event, fields});
		return null;
	},
	close: (): void => {
		// The test owns no analytics files.
	},
});

const waitForRefresh = async (index: CodeIndex, expected: string): Promise<void> => {
	await vi.waitFor(
		() => {
			expect(index.getStatus().refresh).toBe(expected);
		},
		{timeout: 10_000, interval: 10},
	);
};

describe('closed build outcomes', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('distinguishes reuse, publication, and supersession', async () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const database = openDatabase(fixture.config);
		let drift = false;

		try {
			const first = await buildGeneration({adapters: adapterSetOf(typeScriptExtractor), config: fixture.config, database, logger: silentLogger, force: true});
			const reused = await buildGeneration({adapters: adapterSetOf(typeScriptExtractor), config: fixture.config, database, logger: silentLogger});

			expect(first.outcome).toBe('published');
			expect(reused.outcome).toBe('reused');
			expect(first.stages).not.toBeNull();

			if (first.stages === null) {
				throw new Error('Expected measured stages');
			}

			expect(Object.values(first.stages).reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(first.durationMs);
			expect(database.extractionArtifactCount()).toBe(0);
			const firstStartedAt = database.getPublishedGeneration()?.startedAt;

			const staleScan = scanTypeScriptProject(fixture.config, []);
			drift = true;
			const superseded = await buildGeneration({
				adapters: adapterSetOf(typeScriptExtractor),
				config: fixture.config,
				database,
				logger: silentLogger,
				force: true,
				scan: staleScan,
				extractor: driftingExtractor(() => drift),
			});

			expect(superseded.outcome).toBe('superseded');
			expect(superseded.generationId).toBe(first.generationId);
			expect(superseded.revision).toBe(first.revision);
			expect(database.getPublishedGeneration()).toMatchObject({id: first.generationId, revision: first.revision, state: 'published'});

			appendFileSync(join(fixture.config.rootDir, 'src', 'models.ts'), '\nexport const afterDrift = 1;\n');
			const published = await buildGeneration({adapters: adapterSetOf(typeScriptExtractor), config: fixture.config, database, logger: silentLogger});

			expect(published.outcome).toBe('published');
			expect(published.revision).toBe(first.revision + 1);
			const secondStartedAt = database.getPublishedGeneration()?.startedAt;

			expect(firstStartedAt).toBeDefined();
			expect(secondStartedAt).toBeDefined();
			expect(Date.parse(secondStartedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(firstStartedAt ?? ''));
			expect(database.getGeneration(first.generationId)).toMatchObject({startedAt: secondStartedAt, completedAt: expect.any(String)});
		} finally {
			database.close();
		}
	});

	it('discards a first superseded candidate instead of persisting a building row', async () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const database = openDatabase(fixture.config);

		try {
			const scan = scanTypeScriptProject(fixture.config, []);
			const superseded = await buildGeneration({
				adapters: adapterSetOf(typeScriptExtractor),
				config: fixture.config,
				database,
				logger: silentLogger,
				scan,
				extractor: driftingExtractor(() => true),
			});

			expect(superseded.outcome).toBe('superseded');
			expect(superseded.revision).toBe(0);
			expect(database.getPublishedGeneration()).toBeNull();
			expect(database.getGeneration(superseded.generationId)).toBeNull();
		} finally {
			database.close();
		}
	});
});

describe('mid-build supersession', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('retries one mid-build edit and never reports it as a build failure', async () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const database = openDatabase(fixture.config);
		const events: {event: string; fields: Readonly<Record<string, unknown>> | undefined}[] = [];
		let buildCalls = 0;
		let editOnNextBuild = false;
		const extractor: ExtractorType = {
			...typeScriptExtractor,
			build: (config, scan, _cache) => {
				buildCalls += 1;

				if (editOnNextBuild) {
					editOnNextBuild = false;
					appendFileSync(join(config.rootDir, 'src', 'models.ts'), '\nexport const midBuildEdit = 1;\n');
				}

				return buildTypeScriptFacts(config, scan);
			},
		};
		const index = createCodeIndex(fixture.config, database, silentLogger, {
			watch: false,
			extractor,
			adapters: [extractor],
			analytics: recordingAnalytics(events),
			debounceMs: 100,
		});

		try {
			const baseline = await index.ensureReady();
			const baselineCalls = buildCalls;

			appendFileSync(join(fixture.config.rootDir, 'src', 'models.ts'), '\nexport const triggerRebuild = 1;\n');
			editOnNextBuild = true;
			const superseded = await index.ensureReady();

			expect(baseline.outcome).toBe('published');
			expect(superseded.outcome).toBe('superseded');
			expect(superseded.revision).toBe(baseline.revision);
			expect(index.getStatus().refresh).not.toBe('current');
			expect(index.findSymbols({query: 'formatUser', limit: 1}).items).toHaveLength(1);

			await waitForRefresh(index, 'current');

			expect(buildCalls - baselineCalls).toBe(2);
			expect(index.getStatus().revision).toBeGreaterThan(baseline.revision);
			expect(index.findSymbols({query: 'midBuildEdit', limit: 1}).items).toHaveLength(1);
			expect(events.filter((entry) => entry.event === 'build_superseded')).toHaveLength(1);
			expect(events.filter((entry) => entry.event === 'build_failed')).toHaveLength(0);
			expect(events.filter((entry) => entry.event === 'build_complete')).toHaveLength(2);
		} finally {
			await index.close();
		}
	});
});
