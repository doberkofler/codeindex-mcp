import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {readVcsProvenance} from '../src/adapters/vcs/vcsProvenance.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';

const hasCommand = (command: string): boolean => spawnSync(command, ['--version'], {stdio: 'ignore'}).status === 0;

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(path.join(tmpdir(), 'codeindex-vcs-'));
	temporaryDirectories.push(directory);
	return directory;
};

describe('version-control provenance', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('indexes an unversioned workspace without provenance', () => {
		expect(readVcsProvenance(temporaryDirectory())).toStrictEqual({kind: 'none', repository: null, revision: null, relativeRoot: null});
	});

	it('persists provenance injected by the composition root and preserves it on inner opens', () => {
		const directory = temporaryDirectory();
		const databasePath = path.join(directory, 'index.sqlite');
		const provenance = {kind: 'git', repository: 'https://example.com/repo.git', revision: 'abc123', relativeRoot: 'packages/app'} as const;
		const first = IndexDatabase.open(databasePath, {rootDir: directory, projectId: 'vcs-test', vcs: provenance});
		const identity = first.getWorkingCopy();
		first.close();

		const second = IndexDatabase.open(databasePath, {rootDir: directory, projectId: 'vcs-test'});

		expect(identity?.vcs).toStrictEqual(provenance);
		expect(second.getWorkingCopy()?.vcs).toStrictEqual(provenance);
		second.close();
	});

	it.skipIf(!hasCommand('git'))('records Git provenance', () => {
		const directory = temporaryDirectory();
		const git = (...args: readonly string[]): void => {
			const result = spawnSync('git', [...args], {cwd: directory, stdio: 'ignore'});
			expect(result.status).toBe(0);
		};

		writeFileSync(path.join(directory, 'file.txt'), 'content\n');
		git('init', '--quiet');
		git('config', 'user.email', 'test@example.com');
		git('config', 'user.name', 'Test');
		git('add', 'file.txt');
		git('commit', '--quiet', '-m', 'fixture');

		const provenance = readVcsProvenance(directory);

		expect(provenance.kind).toBe('git');
		expect(provenance.revision).toMatch(/^[0-9a-f]{40}$/u);
		expect(provenance.relativeRoot).toBe('.');
	});
});
