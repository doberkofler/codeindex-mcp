import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {WorkspaceWatcher} from '../src/index/workspaceWatcher.ts';
import {silentLogger} from './helpers/fixture.ts';

const includesPath = (paths: readonly string[] | null, target: string): boolean => paths?.includes(target) === true;

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
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-watch-'));
		const sourceDirectory = path.join(directory, 'src');
		mkdirSync(sourceDirectory, {recursive: true});
		const sourcePath = path.join(sourceDirectory, 'example.ts');
		const tsconfigPath = path.join(directory, 'tsconfig.json');
		writeFileSync(sourcePath, 'export const value = 1;\n');
		writeFileSync(tsconfigPath, '{"compilerOptions":{}}\n');
		const changes: (readonly string[] | null)[] = [];
		watcher = new WorkspaceWatcher({
			rootDir: directory,
			logger: silentLogger,
			sourceExtensions: ['.ts'],
			ignoredSegments: ['node_modules', 'dist'],
			onChange: (paths): void => {
				changes.push(paths);
			},
		});
		watcher.start([{absolutePath: sourcePath}], [tsconfigPath]);
		await delay(100);
		const sawSourceChange = (): boolean => changes.some((paths) => includesPath(paths, 'src/example.ts'));
		const sawInvalidation = (): boolean => changes.some((paths) => paths === null);

		appendFileSync(sourcePath, 'export const later = 2;\n');
		await vi.waitFor(
			() => {
				expect(sawSourceChange()).toBe(true);
			},
			{timeout: 3000, interval: 25},
		);

		changes.length = 0;
		writeFileSync(tsconfigPath, '{"compilerOptions":{"strict":true}}\n');
		await vi.waitFor(
			() => {
				expect(sawInvalidation()).toBe(true);
			},
			{timeout: 3000, interval: 25},
		);
	});
});
