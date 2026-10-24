import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {collectOracleConfigFiles, isOracleAuthoredSourceFile, scanOracleProject} from '../src/adapters/oracle/scanProject.ts';
import {type ConfigType} from '../src/core/config/config.ts';

const directories: string[] = [];
const {join} = path;

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'codeindex-oracle-scan-'));
	directories.push(directory);
	return directory;
};

const manifestOf = (
	input: Readonly<{include?: readonly string[]; exclude?: readonly string[]; extensions?: readonly string[]; defaultSchema?: string}> = {},
): string =>
	`${JSON.stringify({
		schemaVersion: 1,
		dialect: '19c',
		defaultSchema: input.defaultSchema ?? 'APP',
		...(input.extensions === undefined ? {} : {extensions: input.extensions}),
		include: input.include ?? ['**/*.pks', '**/*.pkb'],
		exclude: input.exclude ?? [],
	})}\n`;

const configOf = (rootDir: string, projectFilePath: string, projects: readonly string[] = [projectFilePath]): ConfigType => ({
	projectName: 'oracle',
	rootDir,
	extractorId: 'oracle',
	extractorOptions: {},
	projectFilePath,
	projects: projects.map((file, index) => ({name: `context-${String(index)}`, projectFilePath: file})),
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

const fixtureWorkspace = (): Readonly<{root: string; manifest: string}> => {
	const root = realpathSync(temporaryDirectory());
	const manifest = join(root, 'oracle-index.json');

	mkdirSync(join(root, 'database', 'skip'), {recursive: true});
	writeFileSync(join(root, 'database', 'a.pks'), 'create package a as procedure p; end a;\n/\n', 'utf8');
	writeFileSync(join(root, 'database', 'skip', 'b.pks'), 'create package b as procedure p; end b;\n/\n', 'utf8');
	writeFileSync(join(root, 'database', 'c.txt'), 'not oracle source\n', 'utf8');
	writeFileSync(manifest, manifestOf({exclude: ['database/skip/**']}), 'utf8');

	return {root, manifest};
};

describe('Oracle authored source classification', () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('accepts publishable files inside the workspace and rejects every other shape', () => {
		const root = realpathSync(temporaryDirectory());
		const inside = join(root, 'a.pks');
		const ignored = join(root, 'node_modules', 'b.pks');
		const text = join(root, 'c.txt');
		const missing = join(root, 'missing.pks');

		mkdirSync(join(root, 'node_modules'), {recursive: true});
		for (const file of [inside, ignored, text]) {
			writeFileSync(file, 'x', 'utf8');
		}

		expect(isOracleAuthoredSourceFile(inside, root)).toBe(true);
		expect(isOracleAuthoredSourceFile(ignored, root)).toBe(false);
		expect(isOracleAuthoredSourceFile(text, root)).toBe(false);
		expect(isOracleAuthoredSourceFile(missing, root)).toBe(false);
		expect(isOracleAuthoredSourceFile(inside, join(root, 'missing-root'))).toBe(false);
	});
});

describe('Oracle project scanning', () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('honours include, exclude, extension, and ignore filtering', () => {
		const {root, manifest} = fixtureWorkspace();
		const scan = scanOracleProject(configOf(root, manifest));

		expect(scan.files.map((file) => file.path)).toStrictEqual(['database/a.pks']);
		expect(scan.excludedFileCount).toBe(1);
		expect(scan.projectFileCount).toBe(1);
		expect(scan.projects[0]).toMatchObject({name: 'context-0', projectFile: 'oracle-index.json'});
	});

	it('uses manifest-defined extensions and merges duplicate context files', () => {
		const {root, manifest} = fixtureWorkspace();
		const other = join(root, 'other-index.json');

		writeFileSync(join(root, 'database', 'd.ora'), 'create package d as procedure p; end d;\n/\n', 'utf8');
		writeFileSync(manifest, manifestOf({extensions: ['.ora'], include: ['database/**/*.ora']}), 'utf8');
		writeFileSync(other, manifestOf({extensions: ['.ora'], include: ['database/**/*.ora'], defaultSchema: 'OTHER'}), 'utf8');

		const scan = scanOracleProject(configOf(root, manifest, [manifest, other]));

		expect(scan.files.map((file) => file.path)).toStrictEqual(['database/d.ora']);
		expect(scan.projects.map((project) => project.name)).toStrictEqual(['context-0', 'context-1']);
		expect(collectOracleConfigFiles(configOf(root, manifest, [manifest, other]))).toStrictEqual([other, manifest].sort());
	});

	it('records a manifest outside the workspace as a snapshot manifest path', () => {
		const root = realpathSync(temporaryDirectory());
		const outside = join(temporaryDirectory(), 'outside.json');

		writeFileSync(join(root, 'a.pks'), 'create package a as procedure p; end a;\n/\n', 'utf8');
		writeFileSync(outside, manifestOf({include: ['**/*.pks']}), 'utf8');

		const scan = scanOracleProject(configOf(root, outside));

		expect(scan.projects[0]?.projectFile).toBe('manifests/outside.json');
	});

	it('rejects a missing, empty, malformed, and unsafe manifest', () => {
		const {root, manifest} = fixtureWorkspace();

		expect(() => scanOracleProject(configOf(root, join(root, 'missing.json')))).toThrow(/ENOENT/u);

		writeFileSync(manifest, '', 'utf8');
		expect(() => scanOracleProject(configOf(root, manifest))).toThrow(/not valid JSON/u);

		writeFileSync(manifest, '{"schemaVersion":1}\n', 'utf8');
		expect(() => scanOracleProject(configOf(root, manifest))).toThrow(/Invalid Oracle manifest/u);

		writeFileSync(manifest, manifestOf({include: ['../*.pks']}), 'utf8');
		expect(() => scanOracleProject(configOf(root, manifest))).toThrow(/workspace-relative/u);
	});
});
