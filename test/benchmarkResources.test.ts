import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {readStorage, startResourceSampler} from '../src/core/benchmark/resources.ts';
import {createFixtureIndex, type FixtureContextType} from './helpers/fixture.ts';

let fixture: FixtureContextType | undefined;

describe('benchmark resources', () => {
	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('reports database, WAL, shared-memory, and extraction counts', () => {
		fixture = createFixtureIndex('simple-project');
		const storage = readStorage(fixture.database, fixture.config.databasePath);

		expect(storage.databaseBytes).toBeGreaterThan(0);
		expect(storage.totalBytes).toBeGreaterThanOrEqual(storage.databaseBytes);
		expect(storage.contentVersions).toBeGreaterThan(0);
		expect(storage.extractionArtifacts).toBeGreaterThanOrEqual(0);
	});

	it('treats missing sidecar files as zero bytes', () => {
		fixture = createFixtureIndex('simple-project');
		const storage = readStorage(fixture.database, path.join(fixture.config.rootDir, 'missing', 'index.sqlite'));

		expect(storage.walBytes).toBe(0);
		expect(storage.shmBytes).toBe(0);
	});

	it('samples process resources and stops its timer', () => {
		const sampler = startResourceSampler();
		const resources = sampler.stop();

		expect(resources.rssStartBytes).toBeGreaterThan(0);
		expect(resources.rssPeakBytes).toBeGreaterThanOrEqual(resources.rssStartBytes);
		expect(resources.cpuUserMs).toBeGreaterThanOrEqual(0);
		expect(resources.lifetimeMaxRssBytes).toBeGreaterThan(0);
	});

	it('survives repeated pause, resume, and stop calls', () => {
		const sampler = startResourceSampler();

		sampler.pause();
		sampler.pause();
		sampler.resume();
		sampler.resume();
		const resources = sampler.stop();
		sampler.pause();

		expect(resources.rssPeakBytes).toBeGreaterThanOrEqual(resources.rssStartBytes);
		expect(resources.cpuUserMs).toBeGreaterThanOrEqual(0);
	});
});
