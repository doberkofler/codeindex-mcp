import {chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {collectCleanupTargets, removeCleanupTargets, runCleanup, type CleanupRootsType} from '../src/core/cleanup.ts';

const {join} = path;
const temporaryDirectories: string[] = [];

const fixture = (): Readonly<{base: string; roots: CleanupRootsType}> => {
	const base = mkdtempSync(join(tmpdir(), 'codeindex-cleanup-'));
	temporaryDirectories.push(base);

	const index = join(base, 'index');
	const results = join(base, 'results');
	const sharedTemporary = join(base, 'temp', 'opencode');

	mkdirSync(join(index, '0123456789abcdef'), {recursive: true});
	mkdirSync(join(index, 'not-a-database'), {recursive: true});
	mkdirSync(join(sharedTemporary, 'codeindex-smoke'), {recursive: true});
	mkdirSync(results, {recursive: true});
	writeFileSync(join(index, '0123456789abcdef', 'index.sqlite'), 'x'.repeat(1024));
	writeFileSync(join(results, 'report.md'), 'keep');

	return {base, roots: {index, protectedPaths: [results]}};
};

const removeTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('cleanup targets', () => {
	afterEach(removeTemporaryDirectories);

	it('collects only project index databases', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots);

		expect(targets.map((target) => path.relative(base, target.path))).toStrictEqual([join('index', '0123456789abcdef')]);
		expect(targets[0]?.bytes).toBeGreaterThan(0);
	});

	it('never collects shared temporary caches', () => {
		const {base, roots} = fixture();

		const targets = collectCleanupTargets(roots);

		expect(targets.map((target) => target.path)).not.toContain(join(base, 'temp', 'opencode', 'codeindex-smoke'));
	});

	it('refuses to clean while an index process owner is alive', () => {
		const {roots} = fixture();
		const projectDirectory = join(roots.index, '0123456789abcdef');
		writeFileSync(
			join(projectDirectory, `index.sqlite.owner-${String(process.pid)}-deadbeef.json`),
			JSON.stringify({pid: process.pid, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		expect(() => collectCleanupTargets(roots)).toThrow(/code index processes are active/u);
	});

	it('ignores ownership markers left by dead processes', () => {
		const {base, roots} = fixture();
		const projectDirectory = join(roots.index, '0123456789abcdef');
		writeFileSync(
			join(projectDirectory, 'index.sqlite.owner-2147483647-deadbeef.json'),
			JSON.stringify({pid: 2_147_483_647, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		const targets = collectCleanupTargets(roots);

		expect(targets.map((target) => path.relative(base, target.path))).toContain(join('index', '0123456789abcdef'));
	});

	it('removes targets and leaves protected and unrelated directories', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots);

		removeCleanupTargets(targets);

		expect(existsSync(join(base, 'index', '0123456789abcdef'))).toBe(false);
		expect(existsSync(join(base, 'index', 'not-a-database'))).toBe(true);
		expect(existsSync(join(base, 'temp', 'opencode', 'codeindex-smoke'))).toBe(true);
		expect(existsSync(join(base, 'results', 'report.md'))).toBe(true);
	});

	it('refuses a root containing a protected path', () => {
		const {base, roots} = fixture();
		const unsafe: CleanupRootsType = {...roots, index: base};

		expect(() => collectCleanupTargets(unsafe)).toThrow(/inside/u);
	});

	it('refuses a symlinked root', () => {
		const {base, roots} = fixture();
		const link = join(base, 'index-link');
		symlinkSync(roots.index, link);

		expect(() => collectCleanupTargets({...roots, index: link})).toThrow(/symbolic link/u);
	});

	it('skips symlinked children', () => {
		const {base, roots} = fixture();
		const link = join(roots.index, 'fedcba9876543210');
		symlinkSync(join(base, 'results'), link);

		const targets = collectCleanupTargets(roots);

		expect(targets.map((target) => target.path)).not.toContain(link);
		expect(existsSync(join(base, 'results', 'report.md'))).toBe(true);
	});
});

describe('cleanup safety', () => {
	afterEach(removeTemporaryDirectories);

	it('sums nested directories and ignores nested links', () => {
		const {base, roots} = fixture();
		const nested = join(roots.index, 'fedcba9876543210');
		mkdirSync(join(nested, 'nested'), {recursive: true});
		writeFileSync(join(nested, 'nested', 'file.bin'), 'x'.repeat(512));
		symlinkSync(join(base, 'results'), join(nested, 'linked'));

		const target = collectCleanupTargets(roots).find((candidate) => candidate.path === nested);

		expect(target?.bytes).toBe(512);
	});

	it('returns no targets when the cache root does not exist', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets({index: join(base, 'missing-index'), protectedPaths: roots.protectedPaths});

		expect(targets).toStrictEqual([]);
	});

	it('refuses relative, filesystem, and home roots', () => {
		const {base, roots} = fixture();

		expect(() => collectCleanupTargets({...roots, index: 'relative/path'})).toThrow(/unsafe root/u);
		expect(() => collectCleanupTargets({...roots, index: path.parse(base).root})).toThrow(/unsafe root/u);
		expect(() => collectCleanupTargets({...roots, index: homedir()})).toThrow(/home directory/u);
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
			expect(runCleanup(['--help'])).toBe(0);
			expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: codeindex-cli clean'));

			expect(runCleanup(['unexpected'])).toBe(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unexpected argument: unexpected'));
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});

	it('rejects the removed keep-index flag', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

		try {
			expect(runCleanup(['--keep-index'])).toBe(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unknown option'));
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});
});
