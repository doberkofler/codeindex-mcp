import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadTypeScriptProject} from '../src/adapters/typescript/loadProject.ts';
import {type ConfigType} from '../src/core/config/config.ts';

const directories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-load-project-'));
	directories.push(directory);
	return directory;
};

const configOf = (rootDir: string, projectFilePath: string, semanticDiagnostics = false): ConfigType => ({
	projectName: 'project',
	rootDir,
	extractorId: 'typescript',
	extractorOptions: {},
	projectFilePath,
	projects: [{name: 'root', projectFilePath}],
	databasePath: path.join(path.dirname(rootDir), 'index.sqlite'),
	analyticsEnabled: false,
	analyticsPath: path.join(path.dirname(rootDir), 'events.jsonl'),
	maxResultBytes: 32_768,
	maxReadLines: 200,
	semanticDiagnostics,
	projectId: 'project',
	logLevel: 'error',
	configPath: null,
});

const cleanupDirectories = (): void => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('TypeScript project loading', () => {
	afterEach(cleanupDirectories);

	it('rejects a missing configuration and unreadable JSON', () => {
		const root = temporaryDirectory();
		const projectFilePath = path.join(root, 'tsconfig.json');
		const config = configOf(root, projectFilePath);

		expect(() => loadTypeScriptProject(config, path.join(root, 'missing.json'))).toThrow(/does not exist/u);

		writeFileSync(projectFilePath, '{"compilerOptions":', {encoding: 'utf8'});
		expect(() => loadTypeScriptProject(config)).toThrow(/Cannot read TypeScript configuration/u);
	});

	it('maps diagnostics outside the workspace to a null path', () => {
		const base = temporaryDirectory();
		const workspace = path.join(base, 'workspace');
		const outside = path.join(base, 'outside.ts');
		const projectFilePath = path.join(workspace, 'tsconfig.json');

		mkdirSync(workspace, {recursive: true});
		writeFileSync(outside, 'export const broken = ;\n', {encoding: 'utf8'});
		writeFileSync(projectFilePath, JSON.stringify({compilerOptions: {strict: true}, files: ['../outside.ts']}), {encoding: 'utf8'});

		const loaded = loadTypeScriptProject(configOf(workspace, projectFilePath));
		const diagnostic = loaded.diagnostics.find((item) => item.path === null);

		expect(loaded.diagnosticCount).toBeGreaterThan(0);
		expect(diagnostic).toMatchObject({category: 'error', path: null});
	});

	it('includes semantic diagnostics only when configured', () => {
		const workspace = temporaryDirectory();
		const projectFilePath = path.join(workspace, 'tsconfig.json');

		mkdirSync(path.join(workspace, 'src'), {recursive: true});
		writeFileSync(path.join(workspace, 'src', 'value.ts'), 'export const value: string = 1;\n', {encoding: 'utf8'});
		writeFileSync(projectFilePath, JSON.stringify({compilerOptions: {strict: true}, include: ['src/**/*.ts']}), {encoding: 'utf8'});

		const syntactic = loadTypeScriptProject(configOf(workspace, projectFilePath));
		const semantic = loadTypeScriptProject(configOf(workspace, projectFilePath, true));

		expect(syntactic.diagnostics).toStrictEqual([]);
		expect(semantic.diagnosticCount).toBeGreaterThan(0);
		expect(semantic.diagnostics.some((item) => item.code === 2322)).toBe(true);
	});
});
