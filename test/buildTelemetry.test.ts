import {appendFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {buildTypeScriptFacts, typeScriptExtractor} from '@codeindex/adapter-typescript/index';
import {type ExtractorType} from '../src/adapters/types.ts';
import {assertAnalyticsFields} from '../src/core/analytics/events.ts';
import {type AnalyticsRecorderType} from '../src/core/analytics/recorder.ts';
import {buildGeneration} from '../src/core/generation/buildGeneration.ts';
import {persistenceStageTotalOf} from '../src/core/generation/buildReport.ts';
import {createCodeIndex, type CodeIndex} from '../src/core/generation/codeIndex.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {adapterSetOf, testAdaptersFor} from './helpers/adapters.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';

const {join} = path;

const recordingAnalytics = (events: {event: string; fields: Readonly<Record<string, unknown>> | undefined}[]): AnalyticsRecorderType => ({
	enabled: true,
	path: '',
	record: (event, fields): null => {
		events.push({event, fields});
		return null;
	},
	close: (): void => {
		// The test owns no analytics files.
	},
});

const openDatabase = (config: ReturnType<typeof createFixtureConfig>['config']): IndexDatabase =>
	IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		projectId: config.projectId,
		extractorId: config.extractorId,
	});

const firstOf = <ItemType>(items: readonly ItemType[]): ItemType => {
	const [first] = items;

	if (first === undefined) {
		throw new Error('Expected at least one item');
	}

	return first;
};

describe('build telemetry', () => {
	let cleanup: (() => void) | undefined;
	let index: CodeIndex | undefined;

	afterEach(async () => {
		await index?.close();
		index = undefined;
		cleanup?.();
		cleanup = undefined;
	});

	it('describes the latest revision with runtime and declared compiler versions', async () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		writeFileSync(join(fixture.config.rootDir, 'package.json'), JSON.stringify({devDependencies: {typescript: '8.0.0'}}), {encoding: 'utf8'});
		const database = openDatabase(fixture.config);
		const events: {event: string; fields: Readonly<Record<string, unknown>> | undefined}[] = [];
		index = createCodeIndex(fixture.config, database, silentLogger, {
			watch: false,
			analytics: recordingAnalytics(events),
			adapters: testAdaptersFor(fixture.config).adapters,
		});

		const first = await index.ensureReady();
		const firstStatus = index.getStatus();

		expect(firstStatus.scope.extractor).toMatchObject({
			compilerVersion: expect.any(String),
			declaredCompilerVersion: '8.0.0',
			compilerDrift: true,
		});
		expect(first.stages).not.toBeNull();

		if (first.stages === null) {
			throw new Error('Expected measured stages');
		}

		expect(Object.values(first.stages).reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(first.durationMs);
		expect(first.persistence).toBeDefined();

		if (first.persistence === undefined) {
			throw new Error('Expected persistence attribution');
		}

		expect(first.persistence.totalWallMs).toBeLessThanOrEqual(first.durationMs);
		expect(Math.abs(persistenceStageTotalOf(first.persistence) - first.persistence.totalWallMs)).toBeLessThanOrEqual(11);
		expect(assertAnalyticsFields({persistence: first.persistence})).toStrictEqual({persistence: first.persistence});
		const serializedPersistence = JSON.stringify(first.persistence);
		expect(Buffer.byteLength(serializedPersistence, 'utf8')).toBeLessThan(2048);
		expect(serializedPersistence).not.toContain(fixture.config.rootDir);

		appendFileSync(join(fixture.config.rootDir, 'src', 'models.ts'), '\nexport const secondRevision = 1;\n');
		const second = await index.ensureReady();
		const secondStatus = index.getStatus();

		expect(second.outcome).toBe('published');
		expect(second.revision).toBe(first.revision + 1);
		expect(firstStatus.build.startedAt).not.toBe(secondStatus.build.startedAt);
		expect(secondStatus.build).toMatchObject({startedAt: expect.any(String), completedAt: expect.any(String), stages: expect.any(Object)});
		expect(Date.parse(secondStatus.build.startedAt ?? '')).toBeGreaterThan(Date.parse(firstStatus.build.startedAt ?? ''));
		expect(secondStatus.build.stages).not.toBeNull();

		if (secondStatus.build.stages === null) {
			throw new Error('Expected status stages');
		}

		expect(Object.values(secondStatus.build.stages).reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(secondStatus.build.durationMs ?? 0);
	});

	it('emits compiler drift once per observed version pair', async () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		writeFileSync(join(fixture.config.rootDir, 'package.json'), JSON.stringify({devDependencies: {typescript: '8.0.0'}}), {encoding: 'utf8'});
		const database = openDatabase(fixture.config);
		const events: {event: string; fields: Readonly<Record<string, unknown>> | undefined}[] = [];
		index = createCodeIndex(fixture.config, database, silentLogger, {
			watch: false,
			analytics: recordingAnalytics(events),
			adapters: testAdaptersFor(fixture.config).adapters,
		});

		await index.ensureReady();
		await index.ensureReady();

		const drift = events.filter((entry) => entry.event === 'compiler_drift');

		expect(drift).toHaveLength(1);
		expect(drift[0]?.fields).toMatchObject({extractorVersion: expect.any(String), declaredVersion: '8.0.0'});
	});
});

describe('post-publication cache failures', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('keeps publication successful when artifact flush and checkpoint fail', async () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const database = openDatabase(fixture.config);
		const cacheWritingExtractor: ExtractorType = {
			...typeScriptExtractor,
			build: (config, scan, cache) => {
				const facts = buildTypeScriptFacts(config, scan);
				const firstFile = firstOf(scan.files);
				cache?.write({contentSha256: firstFile.sha256, kind: 'test-artifact', payload: '{}'});
				return facts;
			},
		};
		const artifactWrite = vi.spyOn(database, 'putExtractionArtifacts').mockImplementation(() => {
			throw new Error('artifact failure');
		});
		const checkpoint = vi.spyOn(database, 'checkpoint').mockImplementation(() => {
			throw new Error('checkpoint failure');
		});

		try {
			const report = await buildGeneration({
				config: fixture.config,
				database,
				logger: silentLogger,
				force: true,
				extractor: cacheWritingExtractor,
				adapters: adapterSetOf(cacheWritingExtractor),
			});

			expect(report.outcome).toBe('published');
			expect(database.getPublishedGeneration()?.revision).toBe(report.revision);
			expect(artifactWrite).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({artifactKind: 'test-artifact'})]));
			expect(checkpoint).toHaveBeenCalledWith();
			expect(report.persistence).toMatchObject({
				artifactFlushFailures: 1,
				postArtifactCheckpoint: {mode: 'failed', failed: true},
			});
		} finally {
			database.close();
		}
	});
});
