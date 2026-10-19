import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {collectCleanupTargets, removeCleanupTargets, type CleanupOptionsType, type CleanupRootsType} from '../src/core/cleanup.ts';

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

describe('cleanup targets', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

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
