import {realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadConfig} from '../src/core/config/config.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const PROJECTS = [
	{name: 'browser', project: 'tsconfig.json'},
	{name: 'contracts', project: 'contracts/tsconfig.json'},
	{name: 'server', project: 'server/tsconfig.json'},
] as const;

describe('configuration projects', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('loads multiple project contexts from one configuration file', () => {
		const fixture = createFixtureConfig('multi-project', PROJECTS);
		({cleanup} = fixture);
		const directory = path.dirname(fixture.config.databasePath);
		const configPath = path.join(directory, 'codeindex.config.json');
		writeFileSync(
			configPath,
			JSON.stringify({
				project: {name: 'periscope', root: fixture.config.rootDir},
				extractor: {id: 'typescript', projects: PROJECTS},
				storage: {directory: './store', analyticsEnabled: false},
			}),
			'utf8',
		);

		const config = loadConfig({CODE_INDEX_CONFIG: configPath});

		expect(config.projects.map((project) => project.name)).toStrictEqual(['browser', 'contracts', 'server']);
		expect(config.projects.map((project) => project.projectFilePath)).toStrictEqual([
			path.join(realpathSync(fixture.config.rootDir), 'tsconfig.json'),
			path.join(realpathSync(fixture.config.rootDir), 'contracts', 'tsconfig.json'),
			path.join(realpathSync(fixture.config.rootDir), 'server', 'tsconfig.json'),
		]);
		expect(config.projectFilePath).toBe(config.projects[0]?.projectFilePath);
	});

	it('rejects ambiguous project settings', () => {
		const fixture = createFixtureConfig('multi-project', PROJECTS);
		({cleanup} = fixture);
		const configPath = path.join(path.dirname(fixture.config.databasePath), 'ambiguous.json');
		writeFileSync(
			configPath,
			JSON.stringify({
				project: {root: fixture.config.rootDir},
				extractor: {project: 'tsconfig.json', projects: PROJECTS},
				storage: {directory: './store', analyticsEnabled: false},
			}),
			'utf8',
		);

		expect(() => loadConfig({CODE_INDEX_CONFIG: configPath})).toThrow(/mutually exclusive/u);
	});

	it('rejects duplicate context names and project files', () => {
		const fixture = createFixtureConfig('multi-project', PROJECTS);
		({cleanup} = fixture);
		const directory = path.dirname(fixture.config.databasePath);
		const duplicateNamePath = path.join(directory, 'duplicate-name.json');
		writeFileSync(
			duplicateNamePath,
			JSON.stringify({
				project: {root: fixture.config.rootDir},
				extractor: {
					projects: [
						{name: 'browser', project: 'tsconfig.json'},
						{name: 'browser', project: 'contracts/tsconfig.json'},
					],
				},
				storage: {directory: './store', analyticsEnabled: false},
			}),
			'utf8',
		);
		const duplicatePathPath = path.join(directory, 'duplicate-path.json');
		writeFileSync(
			duplicatePathPath,
			JSON.stringify({
				project: {root: fixture.config.rootDir},
				extractor: {
					projects: [
						{name: 'first', project: 'tsconfig.json'},
						{name: 'second', project: 'tsconfig.json'},
					],
				},
				storage: {directory: './store', analyticsEnabled: false},
			}),
			'utf8',
		);

		expect(() => loadConfig({CODE_INDEX_CONFIG: duplicateNamePath})).toThrow(/duplicated/u);
		expect(() => loadConfig({CODE_INDEX_CONFIG: duplicatePathPath})).toThrow(/more than once/u);
	});
});
