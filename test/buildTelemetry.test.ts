import {appendFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {type AnalyticsRecorderType} from '../src/core/analytics/recorder.ts';
import {createCodeIndex, type CodeIndex} from '../src/core/generation/codeIndex.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {testAdaptersFor} from './helpers/adapters.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';

const {join} = path;

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

const openDatabase = (config: ReturnType<typeof createFixtureConfig>['config']): IndexDatabase =>
	IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		projectId: config.projectId,
		extractorId: config.extractorId,
	});

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
		writeFileSync(join(fixture.config.rootDir, 'package.json'), JSON.stringify({devDependencies: {typescript: '7.0.2'}}), {encoding: 'utf8'});
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
			declaredCompilerVersion: '7.0.2',
			compilerDrift: true,
		});
		expect(first.stages).not.toBeNull();

		if (first.stages === null) {
			throw new Error('Expected measured stages');
		}

		expect(Object.values(first.stages).reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(first.durationMs);

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
		writeFileSync(join(fixture.config.rootDir, 'package.json'), JSON.stringify({devDependencies: {typescript: '7.0.2'}}), {encoding: 'utf8'});
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
		expect(drift[0]?.fields).toMatchObject({extractorVersion: expect.any(String), declaredVersion: '7.0.2'});
	});
});
