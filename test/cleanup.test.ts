import {chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {collectCleanupTargets, removeCleanupTargets, runCleanup, type CleanupOptionsType, type CleanupRootsType} from '../src/core/cleanup.ts';

const {join} = path;
const temporaryDirectories: string[] = [];

const current: CleanupOptionsType = {yes: true, all: false};
const all: CleanupOptionsType = {yes: true, all: true};

const fixture = (): Readonly<{base: string; roots: CleanupRootsType}> => {
	const base = mkdtempSync(join(tmpdir(), 'codeindex-cleanup-'));
	temporaryDirectories.push(base);

	const storage = join(base, 'index');
	const results = join(base, 'results');
	const sharedTemporary = join(base, 'temp', 'opencode');

	mkdirSync(join(storage, '0123456789abcdef'), {recursive: true});
	mkdirSync(join(storage, 'fedcba9876543210'), {recursive: true});
	mkdirSync(join(storage, 'not-a-database'), {recursive: true});
	mkdirSync(join(sharedTemporary, 'codeindex-smoke'), {recursive: true});
	mkdirSync(results, {recursive: true});
	writeFileSync(join(storage, '0123456789abcdef', 'index.sqlite'), 'x'.repeat(1024));
	writeFileSync(join(storage, 'fedcba9876543210', 'index.sqlite'), 'x'.repeat(512));
	writeFileSync(join(results, 'report.md'), 'keep');

	return {
		base,
		roots: {
			storage,
			databasePath: join(storage, '0123456789abcdef', 'index.sqlite'),
			protectedPaths: [results],
		},
	};
};

const unusedRoots = (): CleanupRootsType => {
	throw new Error('cleanup must not resolve roots before parsing succeeds');
};

const removeTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('cleanup targets', () => {
	afterEach(removeTemporaryDirectories);

	it('collects only the current project index database', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots, current);

		expect(targets.map((target) => path.relative(base, target.path))).toStrictEqual([join('index', '0123456789abcdef')]);
		expect(targets[0]?.bytes).toBeGreaterThan(0);
	});

	it('collects every managed database with --all', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots, all);

		expect(targets.map((target) => path.relative(base, target.path))).toStrictEqual([join('index', '0123456789abcdef'), join('index', 'fedcba9876543210')]);
	});

	it('never collects shared temporary caches', () => {
		const {base, roots} = fixture();

		for (const options of [current, all]) {
			expect(collectCleanupTargets(roots, options).map((target) => target.path)).not.toContain(join(base, 'temp', 'opencode', 'codeindex-smoke'));
		}
	});

	it('collects only database artifacts for an overridden database path', () => {
		const {base, roots} = fixture();
		const custom = join(base, 'custom');
		mkdirSync(custom, {recursive: true});
		writeFileSync(join(custom, 'state.sqlite'), 'x');
		writeFileSync(join(custom, 'state.sqlite-wal'), 'x');
		writeFileSync(join(custom, 'state.sqlite-shm'), 'x');
		writeFileSync(join(custom, 'state.sqlite.schema-1.bak'), 'x');
		writeFileSync(join(custom, 'unrelated.txt'), 'keep');

		const targets = collectCleanupTargets({...roots, databasePath: join(custom, 'state.sqlite')}, current);

		expect(targets.map((target) => path.basename(target.path)).sort()).toStrictEqual([
			'state.sqlite',
			'state.sqlite-shm',
			'state.sqlite-wal',
			'state.sqlite.schema-1.bak',
		]);
	});

	it('refuses to clean while an index process owner is alive', () => {
		const {roots} = fixture();
		const projectDirectory = join(roots.storage, '0123456789abcdef');
		writeFileSync(
			join(projectDirectory, `index.sqlite.owner-${String(process.pid)}-deadbeef.json`),
			JSON.stringify({pid: process.pid, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		expect(() => collectCleanupTargets(roots, current)).toThrow(/code index processes are active/u);
	});

	it('does not let another workspace process block the current cleanup', () => {
		const {roots} = fixture();
		writeFileSync(
			join(roots.storage, 'fedcba9876543210', `index.sqlite.owner-${String(process.pid)}-deadbeef.json`),
			JSON.stringify({pid: process.pid, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		expect(collectCleanupTargets(roots, current)).toHaveLength(1);
		expect(() => collectCleanupTargets(roots, all)).toThrow(/code index processes are active/u);
	});

	it('ignores ownership markers left by dead processes', () => {
		const {base, roots} = fixture();
		const projectDirectory = join(roots.storage, '0123456789abcdef');
		writeFileSync(
			join(projectDirectory, 'index.sqlite.owner-2147483647-deadbeef.json'),
			JSON.stringify({pid: 2_147_483_647, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		const targets = collectCleanupTargets(roots, current);

		expect(targets.map((target) => path.relative(base, target.path))).toContain(join('index', '0123456789abcdef'));
	});

	it('removes the current target and leaves other workspaces intact', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots, current);

		removeCleanupTargets(targets);

		expect(existsSync(join(base, 'index', '0123456789abcdef'))).toBe(false);
		expect(existsSync(join(base, 'index', 'fedcba9876543210', 'index.sqlite'))).toBe(true);
		expect(existsSync(join(base, 'index', 'not-a-database'))).toBe(true);
		expect(existsSync(join(base, 'temp', 'opencode', 'codeindex-smoke'))).toBe(true);
		expect(existsSync(join(base, 'results', 'report.md'))).toBe(true);
	});

	it('refuses a root containing a protected path', () => {
		const {base, roots} = fixture();
		const unsafe: CleanupRootsType = {...roots, storage: base};

		expect(() => collectCleanupTargets(unsafe, current)).toThrow(/inside/u);
	});

	it('refuses a symlinked storage root', () => {
		const {base, roots} = fixture();
		const link = join(base, 'index-link');
		symlinkSync(roots.storage, link);

		expect(() => collectCleanupTargets({...roots, storage: link}, current)).toThrow(/symbolic link/u);
	});

	it('skips symlinked children', () => {
		const {base, roots} = fixture();
		const link = join(roots.storage, 'aaaabbbbccccdddd');
		symlinkSync(join(base, 'results'), link);

		const targets = collectCleanupTargets(roots, all);

		expect(targets.map((target) => target.path)).not.toContain(link);
		expect(existsSync(join(base, 'results', 'report.md'))).toBe(true);
	});
});

describe('cleanup safety', () => {
	afterEach(removeTemporaryDirectories);

	it('sums nested directories and ignores nested links', () => {
		const {base, roots} = fixture();
		const nested = join(roots.storage, 'fedcba9876543210');
		mkdirSync(join(nested, 'nested'), {recursive: true});
		writeFileSync(join(nested, 'nested', 'file.bin'), 'x'.repeat(512));
		symlinkSync(join(base, 'results'), join(nested, 'linked'));

		const targets = collectCleanupTargets({...roots, databasePath: join(nested, 'index.sqlite')}, current);
		const target = targets.find((candidate) => candidate.path === nested);

		expect(target?.bytes).toBe(1024);
	});

	it('returns no targets when the storage root does not exist', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets({storage: join(base, 'missing-index'), databasePath: null, protectedPaths: roots.protectedPaths}, all);

		expect(targets).toStrictEqual([]);
	});

	it('refuses relative, filesystem, and home roots', () => {
		const {base, roots} = fixture();

		expect(() => collectCleanupTargets({...roots, storage: 'relative/path'}, current)).toThrow(/unsafe root/u);
		expect(() => collectCleanupTargets({...roots, storage: path.parse(base).root}, current)).toThrow(/unsafe root/u);
		expect(() => collectCleanupTargets({...roots, storage: homedir()}, current)).toThrow(/home directory/u);
	});

	it('keeps removing after a target fails', () => {
		const base = mkdtempSync(join(tmpdir(), 'codeindex-cleanup-failure-'));
		const parent = join(base, 'locked');
		const child = join(parent, 'target');
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

		mkdirSync(child, {recursive: true});
		chmodSync(parent, 0o500);

		try {
			expect(removeCleanupTargets([{path: child, bytes: 10}])).toBe(0);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Failed to remove'));
		} finally {
			chmodSync(parent, 0o700);
			stderr.mockRestore();
			rmSync(base, {recursive: true, force: true});
		}
	});

	it('reports usage and rejects unexpected arguments', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

		try {
			expect(runCleanup(['--help'], unusedRoots)).toBe(0);
			expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: codeindex-cli clean'));
			expect(stdout).toHaveBeenCalledWith(expect.stringContaining('--all'));

			expect(runCleanup(['unexpected'], unusedRoots)).toBe(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unexpected argument: unexpected'));
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});

	it('passes the all flag to the roots resolver', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const calls: boolean[] = [];

		try {
			expect(
				runCleanup(['--all'], (value) => {
					calls.push(value);
					return {storage: path.join(tmpdir(), 'codeindex-missing-root'), databasePath: null, protectedPaths: []};
				}),
			).toBe(0);

			expect(calls).toStrictEqual([true]);
			expect(stdout).toHaveBeenCalledWith('Nothing to clean.\n');
		} finally {
			stdout.mockRestore();
		}
	});

	it('rejects the removed keep-index flag', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

		try {
			expect(runCleanup(['--keep-index'], unusedRoots)).toBe(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unknown option'));
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});
});
