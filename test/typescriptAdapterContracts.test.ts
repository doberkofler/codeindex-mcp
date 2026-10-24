import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {loadTypeScriptProject} from '../src/adapters/typescript/loadProject.ts';
import {isAuthoredSourceFile, scanProject} from '../src/adapters/typescript/scanProject.ts';
import {type ConfigType} from '../src/core/config/config.ts';
import {createFixtureConfig, createFixtureIndex} from './helpers/fixture.ts';

const directories: string[] = [];
const {join} = path;

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'codeindex-typescript-contracts-'));
	directories.push(directory);
	return directory;
};

const configOf = (rootDir: string, projectFilePath: string): ConfigType => ({
	projectName: 'project',
	rootDir,
	extractorId: 'typescript',
	extractorOptions: {},
	projectFilePath,
	projects: [{name: 'root', projectFilePath}],
	storageDirectory: join(rootDir, 'storage'),
	databasePath: join(rootDir, 'storage', 'index.sqlite'),
	analyticsEnabled: false,
	analyticsPath: join(rootDir, 'storage', 'events.jsonl'),
	maxResultBytes: 32_768,
	maxReadLines: 200,
	semanticDiagnostics: false,
	projectId: 'project',
	logLevel: 'error',
	configPath: null,
});

const publishedPaths = (fixture: ReturnType<typeof createFixtureIndex>): readonly string[] => {
	const generation = fixture.database.getPublishedGeneration();

	if (generation === null) {
		throw new Error('Expected a published generation');
	}

	return fixture.database.listFiles(generation.id).map((file) => file.path);
};

describe('TypeScript project configuration inheritance', () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('inherits compiler options, include, and exclude from a relative extends array', () => {
		const {config, cleanup} = createFixtureConfig('typescript-extends');

		try {
			const loaded = loadTypeScriptProject(config);
			const options = loaded.program.getCompilerOptions();
			const roots = loaded.program.getRootFileNames().map((file) => path.relative(config.rootDir, file).split(path.sep).join('/'));
			const scan = scanProject(config);

			expect(options).toMatchObject({strict: true, target: 9, noUnusedLocals: false});
			expect(options.paths?.['@base/*']).toStrictEqual(['src/*']);
			expect(roots).toStrictEqual(['src/entry.ts']);
			expect(scan.files.map((file) => file.path)).toStrictEqual(['src/entry.ts']);
			expect(scan.projectFileCount).toBe(1);
			expect(scan.excludedFileCount).toBe(0);
		} finally {
			cleanup();
		}
	});

	it('watches every inherited configuration file and the package manifest', () => {
		const {config, cleanup} = createFixtureConfig('typescript-extends');

		try {
			const watched = typeScriptExtractor
				.configFiles(config)
				.map((file) => path.relative(config.rootDir, file).split(path.sep).join('/'))
				.sort();

			expect(watched).toStrictEqual(['package.json', 'tsconfig.base.json', 'tsconfig.extra.json', 'tsconfig.json']);
		} finally {
			cleanup();
		}
	});

	it('inherits compiler options and file selection from a package base', () => {
		const root = realpathSync(temporaryDirectory());
		const packageDirectory = join(root, 'node_modules', '@fixture', 'base');

		mkdirSync(join(root, 'src'), {recursive: true});
		mkdirSync(packageDirectory, {recursive: true});
		writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'package-extends', private: true}), 'utf8');
		writeFileSync(join(root, 'src', 'main.ts'), 'export const answer: number = 42;\n', 'utf8');
		writeFileSync(join(root, 'src', 'ignored.ts'), 'export const ignored = true;\n', 'utf8');
		writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({name: '@fixture/base', version: '1.0.0', main: 'tsconfig.json'}), 'utf8');
		writeFileSync(
			join(packageDirectory, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true},
				include: ['../../../src/main.ts'],
			}),
			'utf8',
		);

		const projectFilePath = join(root, 'tsconfig.json');
		writeFileSync(projectFilePath, JSON.stringify({extends: ['@fixture/base']}), 'utf8');

		const config = configOf(root, projectFilePath);
		const loaded = loadTypeScriptProject(config);
		const watched = typeScriptExtractor.configFiles(config).map((file) => path.relative(root, file).split(path.sep).join('/'));

		expect(loaded.program.getCompilerOptions()).toMatchObject({strict: true, target: 9});
		expect(loaded.program.getRootFileNames().map((file) => path.basename(file))).toStrictEqual(['main.ts']);
		expect(watched).toContain('node_modules/@fixture/base/package.json');
		expect(watched).toContain('node_modules/@fixture/base/tsconfig.json');
		expect(watched).toContain('package.json');
		expect(watched).toContain('tsconfig.json');
	});

	it('publishes an excluded imported file through the resolved program', () => {
		const fixture = createFixtureIndex('typescript-extends');

		try {
			const scan = scanProject(fixture.config);
			const symbols = fixture.index.findSymbols({query: 'skipped', limit: 10});

			// The scanner would index this path; only the configured exclude removes it.
			expect(isAuthoredSourceFile(join(fixture.config.rootDir, 'src', 'excluded', 'skip.ts'), fixture.config.rootDir)).toBe(true);
			expect(scan.files.map((file) => file.path)).not.toContain('src/excluded/skip.ts');
			expect(publishedPaths(fixture)).toStrictEqual(['src/entry.ts', 'src/excluded/skip.ts']);
			expect(symbols.items.map((symbol) => `${symbol.path}:${symbol.name}`)).toContain('src/excluded/skip.ts:skipped');
		} finally {
			fixture.cleanup();
		}
	});

	it('publishes files roots plus authored imports, but not unrelated authored files', () => {
		const fixture = createFixtureIndex('typescript-files');

		try {
			expect(scanProject(fixture.config).files.map((file) => file.path)).toStrictEqual(['src/selected.ts']);
			expect(publishedPaths(fixture)).toStrictEqual(['src/imported.ts', 'src/selected.ts']);
			expect(fixture.index.findSymbols({query: 'unused', limit: 10}).items).toStrictEqual([]);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('TypeScript CommonJS require dependencies', () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('emits package and authored require edges with variable bindings, destructured bindings, and usage bits', () => {
		const fixture = createFixtureIndex('typescript-require');

		try {
			const generation = fixture.database.getPublishedGeneration();

			if (generation === null) {
				throw new Error('Expected a published generation');
			}

			const authored = fixture.database.findDependencyEdgesByTargets(generation.id, ['src/dep.ts']);
			const packageEdges = fixture.database.findDependencyEdgesByTargetIdentifier(generation.id, 'optional-package');

			expect(
				authored.map((edge) => ({
					sourcePath: edge.sourcePath,
					rawTarget: edge.rawTarget,
					kind: edge.kind,
					targetPath: edge.targetPath,
					targetIdentifier: edge.targetIdentifier,
					compileTimeOnly: edge.compileTimeOnly,
				})),
			).toStrictEqual([
				{sourcePath: 'src/requirer.ts', rawTarget: './dep', kind: 'require', targetPath: 'src/dep.ts', targetIdentifier: null, compileTimeOnly: false},
				{sourcePath: 'src/requirer.ts', rawTarget: './dep', kind: 'require', targetPath: 'src/dep.ts', targetIdentifier: null, compileTimeOnly: false},
			]);
			expect(packageEdges).toHaveLength(1);
			expect(packageEdges[0]).toMatchObject({
				sourcePath: 'src/requirer.ts',
				rawTarget: 'optional-package',
				kind: 'require',
				targetPath: null,
				targetIdentifier: 'optional-package',
				compileTimeOnly: false,
			});
			expect(
				fixture.database.listDependencyBindings(
					generation.id,
					packageEdges.map((edge) => edge.id),
				),
			).toStrictEqual([]);
			const bindings = fixture.database
				.listDependencyBindings(
					generation.id,
					authored.map((edge) => edge.id),
				)
				.map(({edgeId: _edgeId, ...binding}) => binding);

			expect(bindings).toStrictEqual(
				expect.arrayContaining([
					{kind: 'require', importedName: null, exportedName: null, localName: 'whole', compileTimeOnly: false, position: 0},
					{kind: 'require', importedName: 'value', exportedName: null, localName: 'value', compileTimeOnly: false, position: 0},
					{kind: 'require', importedName: 'helper', exportedName: null, localName: 'renamed', compileTimeOnly: false, position: 1},
				]),
			);

			const usageOf = (query: string): readonly Readonly<{role: string; usage: number}>[] => {
				const result = fixture.index.findReferences({query, group: 'occurrence', path: 'src/requirer.ts', limit: 10});

				if (result.kind !== 'occurrences') {
					throw new Error(`Expected rendered occurrences for ${query}`);
				}

				return result.items.map((item) => ({role: item.role, usage: item.usage}));
			};
			const directUsage = fixture.index.findDependencies({target: 'optional-package', detail: 'evidence', limit: 10});
			const evidences = directUsage.items.flatMap((item) => ('evidence' in item ? [item.evidence] : []));

			expect(usageOf('value')).toStrictEqual([
				{role: 'definition', usage: 0},
				{role: 'reference', usage: 2},
				{role: 'reference', usage: 2},
			]);
			expect(usageOf('renamed')).toStrictEqual([
				{role: 'definition', usage: 0},
				{role: 'reference', usage: 2},
				{role: 'reference', usage: 1},
			]);
			expect(directUsage.items.map(({path: itemPath, depth, directRoot}) => ({path: itemPath, depth, directRoot}))).toStrictEqual([
				{path: 'src/requirer.ts', depth: 1, directRoot: 'src/requirer.ts'},
			]);
			expect(evidences).toHaveLength(1);
			expect(evidences[0]).toMatchObject({
				targetIdentifier: 'optional-package',
				kind: 'require',
				bindings: [],
			});
			expect(directUsage.summary).toStrictEqual({totalConsumers: 1, directConsumers: 1, transitiveConsumers: 0, roots: []});
		} finally {
			fixture.cleanup();
		}
	});
});

describe('TypeScript unsupported construct diagnostics', () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('publishes one complete generation carrying the bounded parser diagnostic', () => {
		const {config, cleanup} = createFixtureConfig('typescript-invalid');

		try {
			const loaded = loadTypeScriptProject(config);

			expect(loaded.diagnostics).toHaveLength(1);
			expect(loaded.diagnostics[0]).toMatchObject({category: 'error', code: 1110, path: 'src/broken.ts'});
			expect(loaded.diagnosticCount).toBe(1);

			const fixture = createFixtureIndex('typescript-invalid');

			try {
				const verification = fixture.index.verify();
				const published = fixture.database.getPublishedGeneration();

				expect(verification.counts).toMatchObject({files: 1, diagnostics: 1});
				expect(verification.metadataMatches).toBe(true);
				expect(publishedPaths(fixture)).toStrictEqual(['src/broken.ts']);
				expect(fixture.database.generationCount()).toBe(1);
				expect(published).toMatchObject({state: 'published'});
			} finally {
				fixture.cleanup();
			}
		} finally {
			cleanup();
		}
	});
});
