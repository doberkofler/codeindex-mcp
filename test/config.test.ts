import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadConfig, toRepositoryPath} from '../src/config/config.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

describe('configuration', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('resolves the configured root and project file', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);

		const config = loadConfig({
			CODE_INDEX_ROOT: fixture.config.rootDir,
			CODE_INDEX_PROJECT_FILE: 'tsconfig.json',
			CODE_INDEX_DATABASE: fixture.config.databasePath,
		});

		expect(config.rootDir).toBe(realpathSync(fixture.config.rootDir));
		expect(config.projectFilePath).toBe(realpathSync(fixture.config.projectFilePath));
		expect(config.maxResultBytes).toBe(32_768);
		expect(config.maxReadLines).toBe(200);
	});

	it('rejects a database inside the indexed working copy', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);

		expect(() =>
			loadConfig({
				CODE_INDEX_ROOT: fixture.config.rootDir,
				CODE_INDEX_PROJECT_FILE: 'tsconfig.json',
				CODE_INDEX_DATABASE: path.join(fixture.config.rootDir, 'index.sqlite'),
			}),
		).toThrow(/outside the indexed working copy/u);
	});

	it('rejects a tsconfig outside the root', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'code-index-config-'));

		try {
			expect(() =>
				loadConfig({
					CODE_INDEX_ROOT: directory,
					CODE_INDEX_PROJECT_FILE: '../escape/tsconfig.json',
					CODE_INDEX_DATABASE: path.join(directory, '..', 'index.sqlite'),
				}),
			).toThrow(/does not exist|inside/u);
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('rejects repository paths that escape the root', () => {
		expect(() => toRepositoryPath('/root/workspace', '/root/elsewhere/file.ts')).toThrow(/outside/u);
		expect(toRepositoryPath('/root/workspace', '/root/workspace/src/file.ts')).toBe('src/file.ts');
	});
});

describe('configuration files', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('loads a configuration file with paths relative to the file', () => {
		const fixture = createFixtureConfig('simple-project');
		const directory = path.dirname(fixture.config.databasePath);
		const configPath = path.join(directory, 'codeindex.config.json');
		writeFileSync(
			configPath,
			JSON.stringify({
				project: {name: 'fixture', root: fixture.config.rootDir},
				extractor: {id: 'typescript', project: 'tsconfig.json'},
				storage: {directory: './store', analyticsEnabled: false},
				limits: {maxResultBytes: 4096, maxReadLines: 20},
			}),
			'utf8',
		);

		try {
			const config = loadConfig({CODE_INDEX_CONFIG: configPath});

			expect(config.projectName).toBe('fixture');
			expect(config.extractorId).toBe('typescript');
			expect(config.projectFilePath).toBe(realpathSync(fixture.config.projectFilePath));
			expect(config.databasePath).toBe(path.join(realpathSync(directory), 'store', config.projectId, 'index.sqlite'));
			expect(config.analyticsEnabled).toBe(false);
			expect(config.maxResultBytes).toBe(4096);
			expect(config.maxReadLines).toBe(20);
		} finally {
			fixture.cleanup();
		}
	});

	it('rejects an invalid configuration file', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'code-index-config-'));

		try {
			const configPath = path.join(directory, 'config.json');
			writeFileSync(configPath, JSON.stringify({extractor: {id: 42}}), 'utf8');

			expect(() => loadConfig({CODE_INDEX_CONFIG: configPath})).toThrow(/failed validation/u);
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});
