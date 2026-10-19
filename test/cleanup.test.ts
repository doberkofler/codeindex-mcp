import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {collectCleanupTargets, removeCleanupTargets, runCleanup, type CleanupOptionsType, type CleanupRootsType} from '../src/core/cleanup.ts';

const {join} = path;
const temporaryDirectories: string[] = [];

const options = (overrides: Partial<CleanupOptionsType> = {}): CleanupOptionsType => ({
	yes: true,
	keepIndex: false,
	...overrides,
});

const fixture = (): Readonly<{base: string; roots: CleanupRootsType}> => {
	const base = mkdtempSync(join(tmpdir(), 'codeindex-cleanup-'));
	temporaryDirectories.push(base);

	const opencode = join(base, 'opencode');
	const index = join(base, 'index');
	const results = join(base, 'results');

	mkdirSync(join(opencode, 'codeindex-smoke'), {recursive: true});
	mkdirSync(join(opencode, 'other-tool'), {recursive: true});
	mkdirSync(join(index, '0123456789abcdef'), {recursive: true});
	mkdirSync(results, {recursive: true});
	writeFileSync(join(index, '0123456789abcdef', 'index.sqlite'), 'x'.repeat(1024));
	writeFileSync(join(results, 'report.md'), 'keep');

	return {base, roots: {opencode, index, protectedPaths: [results]}};
};

const removeTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('cleanup targets', () => {
	afterEach(removeTemporaryDirectories);

	it('collects only known code index caches', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots, options());

		expect(targets.map((target) => path.relative(base, target.path))).toStrictEqual([join('opencode', 'codeindex-smoke'), join('index', '0123456789abcdef')]);
		expect(targets[1]?.bytes).toBeGreaterThan(0);
	});

	it('honours the keep flag', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots, options({keepIndex: true}));

		expect(targets.map((target) => path.relative(base, target.path))).toStrictEqual([join('opencode', 'codeindex-smoke')]);
	});

	it('refuses to clean while an index process owner is alive', () => {
		const {roots} = fixture();
		const projectDirectory = join(roots.index, '0123456789abcdef');
		writeFileSync(
			join(projectDirectory, `index.sqlite.owner-${String(process.pid)}-deadbeef.json`),
			JSON.stringify({pid: process.pid, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		expect(() => collectCleanupTargets(roots, options())).toThrow(/code index processes are active/u);
	});

	it('ignores ownership markers left by dead processes', () => {
		const {base, roots} = fixture();
		const projectDirectory = join(roots.index, '0123456789abcdef');
		writeFileSync(
			join(projectDirectory, 'index.sqlite.owner-2147483647-deadbeef.json'),
			JSON.stringify({pid: 2_147_483_647, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		const targets = collectCleanupTargets(roots, options());

		expect(targets.map((target) => path.relative(base, target.path))).toContain(join('index', '0123456789abcdef'));
	});

	it('removes targets and leaves protected and unrelated directories', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(roots, options());

		removeCleanupTargets(targets);

		expect(existsSync(join(base, 'opencode', 'codeindex-smoke'))).toBe(false);
		expect(existsSync(join(base, 'index', '0123456789abcdef'))).toBe(false);
		expect(existsSync(join(base, 'opencode', 'other-tool'))).toBe(true);
		expect(existsSync(join(base, 'results', 'report.md'))).toBe(true);
	});

	it('refuses a root containing a protected path', () => {
		const {base, roots} = fixture();
		const unsafe: CleanupRootsType = {...roots, opencode: base};

		expect(() => collectCleanupTargets(unsafe, options())).toThrow(/inside/u);
	});

	it('refuses a symlinked root', () => {
		const {base, roots} = fixture();
		const link = join(base, 'opencode-link');
		symlinkSync(roots.opencode, link);

		expect(() => collectCleanupTargets({...roots, opencode: link}, options())).toThrow(/symbolic link/u);
	});

	it('skips symlinked children', () => {
		const {base, roots} = fixture();
		const link = join(roots.opencode, 'codeindex-linked');
		symlinkSync(join(base, 'results'), link);

		const targets = collectCleanupTargets(roots, options());

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

		const target = collectCleanupTargets(roots, options()).find((candidate) => candidate.path === nested);

		expect(target?.bytes).toBe(512);
	});

	it('returns no targets when cache roots do not exist', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets(
			{opencode: join(base, 'missing-opencode'), index: join(base, 'missing-index'), protectedPaths: roots.protectedPaths},
			options(),
		);

		expect(targets).toStrictEqual([]);
	});

	it('refuses relative, filesystem, and home roots', () => {
		const {base, roots} = fixture();

		expect(() => collectCleanupTargets({...roots, opencode: 'relative/path'}, options())).toThrow(/unsafe root/u);
		expect(() => collectCleanupTargets({...roots, opencode: path.parse(base).root}, options())).toThrow(/unsafe root/u);
		expect(() => collectCleanupTargets({...roots, opencode: homedir()}, options())).toThrow(/home directory/u);
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
});
