import {appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {WorkspaceWatcher} from '../src/core/freshness/workspaceWatcher.ts';
import {silentLogger} from './helpers/fixture.ts';

const SOURCE_PATH = 'src/example.ts';
const DEFAULT_IGNORED_SEGMENTS = ['node_modules', 'dist'];

type WorkspaceType = Readonly<{
	directory: string;
	sourcePath: string;
	configPath: string;
	changes: (readonly string[] | null)[];
}>;

const createWorkspace = (): WorkspaceType => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-watch-'));
	const sourceDirectory = path.join(directory, 'src');
	const sourcePath = path.join(sourceDirectory, 'example.ts');
	const configPath = path.join(directory, 'tsconfig.json');
	mkdirSync(sourceDirectory, {recursive: true});
	writeFileSync(sourcePath, 'export const value = 1;\n');
	writeFileSync(configPath, '{"compilerOptions":{}}\n');

	return {directory, sourcePath, configPath, changes: []};
};

const startWatcher = (workspace: WorkspaceType, ignoredSegments: readonly string[] = DEFAULT_IGNORED_SEGMENTS): WorkspaceWatcher => {
	const watcher = new WorkspaceWatcher({
		rootDir: workspace.directory,
		logger: silentLogger,
		sourceExtensions: ['.ts'],
		ignoredSegments,
		onChange: (paths): void => {
			workspace.changes.push(paths);
		},
	});
	watcher.start([{absolutePath: workspace.sourcePath}], [workspace.configPath]);

	return watcher;
};

const includesPath = (paths: readonly string[] | null, target: string): boolean => paths?.includes(target) === true;

const waitForPath = async (workspace: WorkspaceType, target: string): Promise<void> => {
	await vi.waitFor(
		() => {
			expect(workspace.changes.some((paths) => includesPath(paths, target))).toBe(true);
		},
		{timeout: 3000, interval: 25},
	);
};

const waitForInvalidation = async (workspace: WorkspaceType): Promise<void> => {
	await vi.waitFor(
		() => {
			expect(workspace.changes.some((paths) => paths === null)).toBe(true);
		},
		{timeout: 3000, interval: 25},
	);
};

describe('WorkspaceWatcher', () => {
	let directory: string | undefined;
	let watcher: WorkspaceWatcher | undefined;

	afterEach(() => {
		watcher?.close();
		watcher = undefined;

		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('reports changed files and project-wide config invalidation', async () => {
		const workspace = createWorkspace();
		({directory} = workspace);
		watcher = startWatcher(workspace);
		await delay(100);

		appendFileSync(workspace.sourcePath, 'export const later = 2;\n');
		await waitForPath(workspace, SOURCE_PATH);

		workspace.changes.length = 0;
		writeFileSync(workspace.configPath, '{"compilerOptions":{"strict":true}}\n');
		await waitForInvalidation(workspace);
		expect(workspace.changes).toContain(null);
	});

	it('reports atomic writes, deletion, and recreation', async () => {
		const workspace = createWorkspace();
		({directory} = workspace);
		watcher = startWatcher(workspace);
		await delay(100);

		const replacementPath = path.join(path.dirname(workspace.sourcePath), 'example.tmp');
		writeFileSync(replacementPath, 'export const value = 2;\n');
		renameSync(replacementPath, workspace.sourcePath);
		await waitForPath(workspace, SOURCE_PATH);

		workspace.changes.length = 0;
		rmSync(workspace.sourcePath);
		await waitForPath(workspace, SOURCE_PATH);

		workspace.changes.length = 0;
		writeFileSync(workspace.sourcePath, 'export const value = 3;\n');
		await waitForPath(workspace, SOURCE_PATH);
		expect(workspace.changes.some((paths) => includesPath(paths, SOURCE_PATH))).toBe(true);
	});

	it('ignores configured directory segments', async () => {
		const workspace = createWorkspace();
		({directory} = workspace);
		const ignoredDirectory = path.join(workspace.directory, 'node_modules', 'package');
		const ignoredPath = path.join(ignoredDirectory, 'example.ts');
		mkdirSync(ignoredDirectory, {recursive: true});
		writeFileSync(ignoredPath, 'export const value = 1;\n');
		watcher = new WorkspaceWatcher({
			rootDir: workspace.directory,
			logger: silentLogger,
			sourceExtensions: ['.ts'],
			ignoredSegments: DEFAULT_IGNORED_SEGMENTS,
			onChange: (paths): void => {
				workspace.changes.push(paths);
			},
		});
		watcher.start([{absolutePath: ignoredPath}], []);
		await delay(100);

		writeFileSync(ignoredPath, 'export const value = 2;\n');
		await delay(500);

		expect(workspace.changes).toStrictEqual([]);
	});
});

describe('WorkspaceWatcher directory changes', () => {
	let directory: string | undefined;
	let watcher: WorkspaceWatcher | undefined;

	afterEach(() => {
		watcher?.close();
		watcher = undefined;

		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('reports a file created in a previously unknown nested directory', async () => {
		const workspace = createWorkspace();
		({directory} = workspace);
		watcher = startWatcher(workspace);
		await delay(100);

		const nestedDirectory = path.join(workspace.directory, 'src', 'deep', 'deeper');
		mkdirSync(nestedDirectory, {recursive: true});
		writeFileSync(path.join(nestedDirectory, 'later.ts'), 'export const nested = 1;\n');

		await vi.waitFor(
			() => {
				expect(workspace.changes.length).toBeGreaterThan(0);
			},
			{timeout: 3000, interval: 25},
		);
	});

	it('reports an existing file changed inside a nested directory', async () => {
		const workspace = createWorkspace();
		({directory} = workspace);
		const nestedDirectory = path.join(workspace.directory, 'src', 'nested');
		const nestedPath = path.join(nestedDirectory, 'existing.ts');
		mkdirSync(nestedDirectory, {recursive: true});
		writeFileSync(nestedPath, 'export const existing = 1;\n');
		watcher = startWatcher(workspace);
		await delay(100);

		appendFileSync(nestedPath, 'export const changed = 2;\n');
		await waitForPath(workspace, 'src/nested/existing.ts');
		expect(workspace.changes.some((paths) => includesPath(paths, 'src/nested/existing.ts'))).toBe(true);
	});

	it('reports removal of a directory tree', async () => {
		const workspace = createWorkspace();
		({directory} = workspace);
		const removedDirectory = path.join(workspace.directory, 'src', 'removed');
		mkdirSync(removedDirectory, {recursive: true});
		writeFileSync(path.join(removedDirectory, 'gone.ts'), 'export const gone = 1;\n');
		watcher = startWatcher(workspace);
		await delay(100);

		rmSync(removedDirectory, {recursive: true, force: true});

		await vi.waitFor(
			() => {
				expect(workspace.changes.length).toBeGreaterThan(0);
			},
			{timeout: 3000, interval: 25},
		);
	});
});
