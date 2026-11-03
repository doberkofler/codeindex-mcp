import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadConfig, toRepositoryPath} from '../src/core/config/config.ts';
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

		const config = loadConfig(
			{
				CODE_INDEX_ROOT: fixture.config.rootDir,
				CODE_INDEX_PROJECT_FILE: 'tsconfig.json',
				CODE_INDEX_DATABASE: fixture.config.databasePath,
			},
			fixture.config.rootDir,
		);

		expect(config.rootDir).toBe(realpathSync(fixture.config.rootDir));
		expect(config.projectFilePath).toBe(realpathSync(fixture.config.projectFilePath));
		expect(config.maxResultBytes).toBe(32_768);
		expect(config.maxReadLines).toBe(200);
	});

	it('resolves CODE_INDEX_PROJECT_FILE relative to the current working directory', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const workingDirectory = path.dirname(fixture.config.rootDir);

		const config = loadConfig(
			{
				CODE_INDEX_ROOT: fixture.config.rootDir,
				CODE_INDEX_PROJECT_FILE: path.join(path.basename(fixture.config.rootDir), 'tsconfig.json'),
				CODE_INDEX_DATABASE: fixture.config.databasePath,
			},
			workingDirectory,
		);

		expect(config.projectFilePath).toBe(realpathSync(fixture.config.projectFilePath));
	});

	it('rejects absolute and URL adapter module specifiers', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const configPath = path.join(fixture.config.rootDir, 'codeindex.config.json');

		for (const module of [path.join(fixture.config.rootDir, 'adapter.mjs'), 'https://example.com/adapter.mjs', 'data:text/javascript,export {}']) {
			writeFileSync(configPath, JSON.stringify({extractors: [{id: 'typescript', module, project: 'tsconfig.json'}]}), 'utf8');
			expect(() => loadConfig({CODE_INDEX_CONFIG: configPath})).toThrow(/module must be a bare package name or a relative path/u);
		}
	});

	it('rejects a database inside the indexed working copy', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);

		expect(() =>
			loadConfig(
				{
					CODE_INDEX_ROOT: fixture.config.rootDir,
					CODE_INDEX_PROJECT_FILE: 'tsconfig.json',
					CODE_INDEX_DATABASE: path.join(fixture.config.rootDir, 'index.sqlite'),
				},
				fixture.config.rootDir,
			),
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

describe('configuration storage binding', () => {
	it('keeps the storage location bound to the checkout when the project id is pinned', () => {
		const base = mkdtempSync(path.join(tmpdir(), 'code-index-config-'));
		const store = path.join(base, 'store');
		const checkout = (name: string, projectId?: string): string => {
			const workspace = path.join(base, name);
			mkdirSync(path.join(workspace, 'src'), {recursive: true});
			writeFileSync(
				path.join(workspace, 'tsconfig.json'),
				JSON.stringify({compilerOptions: {target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true}, include: ['src/**/*']}),
			);
			writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const value = 1;\n');
			const configPath = path.join(workspace, 'codeindex.config.json');
			writeFileSync(
				configPath,
				JSON.stringify({
					project: {...(projectId === undefined ? {} : {id: projectId}), root: '.'},
					extractor: {id: 'typescript', project: 'tsconfig.json'},
					storage: {directory: store},
				}),
			);
			return configPath;
		};

		try {
			const left = loadConfig({CODE_INDEX_CONFIG: checkout('left', 'pinned-project')});
			const right = loadConfig({CODE_INDEX_CONFIG: checkout('right', 'pinned-project')});
			const derived = loadConfig({CODE_INDEX_CONFIG: checkout('derived')});

			expect(left.projectId).toBe('pinned-project');
			expect(right.projectId).toBe('pinned-project');
			expect(left.databasePath).not.toBe(right.databasePath);
			expect(path.basename(path.dirname(left.databasePath))).toMatch(/^[0-9a-f]{16}$/u);
			expect(path.basename(path.dirname(derived.databasePath))).toBe(derived.projectId);
		} finally {
			rmSync(base, {recursive: true, force: true});
		}
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

describe('multi-adapter configuration', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('normalizes the singular extractor form into one required adapter', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const configPath = path.join(path.dirname(fixture.config.rootDir), 'codeindex.config.json');

		writeFileSync(
			configPath,
			JSON.stringify({
				project: {name: 'singular'},
				extractor: {id: 'typescript', project: path.join(fixture.config.rootDir, 'tsconfig.json')},
			}),
		);

		const config = loadConfig(
			{CODE_INDEX_CONFIG: configPath, CODE_INDEX_DATABASE: fixture.config.databasePath, CODE_INDEX_ROOT: fixture.config.rootDir},
			fixture.config.rootDir,
		);

		expect(config.adapters).toHaveLength(1);
		expect(config.adapters?.[0]).toMatchObject({id: 'typescript', required: true});
		expect(config.extractorId).toBe('typescript');
	});

	it('parses plural extractors with required defaulting to true', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const configPath = path.join(path.dirname(fixture.config.rootDir), 'codeindex.config.json');
		const manifestPath = path.join(fixture.config.rootDir, 'oracle-index.json');

		writeFileSync(manifestPath, JSON.stringify({schemaVersion: 1, dialect: '19c', defaultSchema: 'APP', include: ['src/**/*.ts']}));
		writeFileSync(
			configPath,
			JSON.stringify({
				project: {name: 'plural'},
				extractors: [
					{id: 'typescript', projects: [{name: 'app', project: path.join(fixture.config.rootDir, 'tsconfig.json')}]},
					{
						id: 'oracle',
						required: false,
						projects: [{name: 'database', project: manifestPath}],
					},
				],
			}),
		);

		const config = loadConfig(
			{CODE_INDEX_CONFIG: configPath, CODE_INDEX_DATABASE: fixture.config.databasePath, CODE_INDEX_ROOT: fixture.config.rootDir},
			fixture.config.rootDir,
		);

		expect(config.adapters?.map((adapter) => `${adapter.id}:${String(adapter.required)}`)).toStrictEqual(['typescript:true', 'oracle:false']);
		expect(config.projectId).toBeDefined();
	});
});

describe('multi-adapter storage identity', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('keeps one storage key while the adapter set changes in the same configuration file', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const configPath = path.join(path.dirname(fixture.config.rootDir), 'codeindex.config.json');
		const project = path.join(fixture.config.rootDir, 'tsconfig.json');
		const manifestPath = path.join(fixture.config.rootDir, 'oracle-index.json');
		const load = (): ReturnType<typeof loadConfig> =>
			loadConfig(
				{CODE_INDEX_CONFIG: configPath, CODE_INDEX_DATABASE: fixture.config.databasePath, CODE_INDEX_ROOT: fixture.config.rootDir},
				fixture.config.rootDir,
			);

		writeFileSync(manifestPath, JSON.stringify({schemaVersion: 1, dialect: '19c', defaultSchema: 'APP', include: ['src/**/*.ts']}));
		writeFileSync(configPath, JSON.stringify({extractors: [{id: 'typescript', projects: [{project}]}]}));
		const singular = load();

		writeFileSync(
			configPath,
			JSON.stringify({
				extractors: [
					{id: 'typescript', projects: [{project}]},
					{
						id: 'oracle',
						required: false,
						projects: [{project: manifestPath}],
					},
				],
			}),
		);
		const multi = load();

		expect(multi.databasePath).toBe(singular.databasePath);
	});

	it('rejects ambiguous and duplicate plural configuration', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const configPath = path.join(path.dirname(fixture.config.rootDir), 'codeindex.config.json');
		const project = path.join(fixture.config.rootDir, 'tsconfig.json');

		writeFileSync(
			configPath,
			JSON.stringify({
				extractor: {id: 'typescript'},
				extractors: [{id: 'typescript', projects: [{project}]}],
			}),
		);
		expect(() =>
			loadConfig({CODE_INDEX_CONFIG: configPath, CODE_INDEX_DATABASE: fixture.config.databasePath, CODE_INDEX_ROOT: fixture.config.rootDir}),
		).toThrow(/extractor or extractors/u);

		writeFileSync(
			configPath,
			JSON.stringify({
				extractors: [
					{id: 'typescript', projects: [{project}]},
					{id: 'typescript', projects: [{project: path.join(import.meta.dirname, 'fixtures', 'oracle-project', 'oracle-index.json')}]},
				],
			}),
		);
		expect(() =>
			loadConfig({CODE_INDEX_CONFIG: configPath, CODE_INDEX_DATABASE: fixture.config.databasePath, CODE_INDEX_ROOT: fixture.config.rootDir}),
		).toThrow(/more than once/u);

		writeFileSync(configPath, JSON.stringify({extractors: [{id: 'typescript', projects: [{project}]}]}));
		expect(() =>
			loadConfig({
				CODE_INDEX_CONFIG: configPath,
				CODE_INDEX_DATABASE: fixture.config.databasePath,
				CODE_INDEX_ROOT: fixture.config.rootDir,
				CODE_INDEX_EXTRACTOR: 'typescript',
			}),
		).toThrow(/cannot be combined with extractors/u);
	});
});
