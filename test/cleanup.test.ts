import {chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {indexRootDirectory} from '../src/core/config/config.ts';
import {cleanupRootsOf} from '../src/transports/cli/runCli.ts';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	collectCleanupTargets,
	executeCleanup,
	formatSize,
	removeCleanupTargets,
	runCleanup,
	type CleanupOptionsType,
	type CleanupRootsType,
} from '../src/core/cleanup.ts';

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

	it('reclaims a legacy explicit project id directory with --all', () => {
		const {base, roots} = fixture();
		const legacy = join(roots.storage, 'legacy-project');
		mkdirSync(legacy, {recursive: true});
		writeFileSync(join(legacy, 'index.sqlite'), 'x');

		expect(collectCleanupTargets(roots, all).map((target) => path.relative(base, target.path))).toContain(join('index', 'legacy-project'));
		expect(collectCleanupTargets(roots, current).map((target) => target.path)).not.toContain(legacy);
	});

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

	it('returns no targets when the current database directory does not exist', () => {
		const {base, roots} = fixture();
		const targets = collectCleanupTargets({...roots, databasePath: join(base, 'missing', 'state.sqlite')}, current);

		expect(targets).toStrictEqual([]);
	});

	it('refuses a current project without a resolved database path', () => {
		const {roots} = fixture();

		expect(() => collectCleanupTargets({...roots, databasePath: null}, current)).toThrow(/no database path was resolved/u);
	});

	it('skips a missing or symlinked managed project directory', () => {
		const {base, roots} = fixture();
		const missing = join(roots.storage, 'aaaabbbbccccdddd', 'index.sqlite');
		const linkName = join(roots.storage, 'bbbbccccddddeeee');
		const linked = join(base, 'linked-project');
		mkdirSync(linked, {recursive: true});
		writeFileSync(join(linked, 'index.sqlite'), 'x');
		symlinkSync(linked, linkName);

		expect(collectCleanupTargets({...roots, databasePath: missing}, current)).toStrictEqual([]);
		expect(collectCleanupTargets({...roots, databasePath: join(linkName, 'index.sqlite')}, current)).toStrictEqual([]);
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
});

describe('cleanup filesystem failures', () => {
	afterEach(removeTemporaryDirectories);

	it('ignores directories and files that deny inspection when sizing a target', () => {
		const {roots} = fixture();
		const projectDirectory = join(roots.storage, '0123456789abcdef');
		const unlistable = join(projectDirectory, 'unlistable');
		const unstatable = join(projectDirectory, 'unstatable');

		mkdirSync(unlistable, {recursive: true});
		mkdirSync(unstatable, {recursive: true});
		writeFileSync(join(unlistable, 'ignored.bin'), 'x'.repeat(2048));
		writeFileSync(join(unstatable, 'ignored.bin'), 'x'.repeat(2048));
		chmodSync(unlistable, 0o000);
		chmodSync(unstatable, 0o400);

		try {
			const targets = collectCleanupTargets(roots, current);
			const target = targets.find((candidate) => candidate.path === projectDirectory);

			expect(target?.bytes).toBe(1024);
		} finally {
			chmodSync(unlistable, 0o700);
			chmodSync(unstatable, 0o700);
		}
	});

	it('skips database artifacts that deny inspection', () => {
		const {base, roots} = fixture();
		const custom = join(base, 'custom');
		mkdirSync(custom, {recursive: true});
		writeFileSync(join(custom, 'state.sqlite'), 'x');
		chmodSync(custom, 0o400);

		try {
			expect(collectCleanupTargets({...roots, databasePath: join(custom, 'state.sqlite')}, current)).toStrictEqual([]);
		} finally {
			chmodSync(custom, 0o700);
		}
	});
});

describe('cleanup safety failures', () => {
	afterEach(removeTemporaryDirectories);

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

const captureIo = (): Readonly<{stdout: string[]; stderr: string[]; io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>}> => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
	};
};

describe('cleanup presentation', () => {
	afterEach(removeTemporaryDirectories);

	it('prints nothing to clean and exits zero for an empty target set', () => {
		const captured = captureIo();
		const roots: CleanupRootsType = {storage: join(tmpdir(), 'codeindex-missing-cleanup-root'), databasePath: null, protectedPaths: []};

		expect(runCleanup(['--all'], () => roots, captured.io)).toBe(0);
		expect(captured.stdout).toStrictEqual(['Nothing to clean.']);
		expect(captured.stderr).toStrictEqual([]);
	});

	it('lists every target and the total for a dry run without deleting', () => {
		const {base, roots} = fixture();
		const captured = captureIo();

		executeCleanup({yes: false, all: false}, () => roots, captured.io);

		expect(captured.stdout).toStrictEqual([
			`would remove ${join(base, 'index', '0123456789abcdef')} (1.0 KB)`,
			'Dry run: 1.0 KB in 1 target(s). Pass --yes to delete.',
		]);
		expect(existsSync(join(base, 'index', '0123456789abcdef', 'index.sqlite'))).toBe(true);
	});

	it('removes targets and reports the reclaimed total', () => {
		const {base, roots} = fixture();
		const captured = captureIo();

		executeCleanup({yes: true, all: false}, () => roots, captured.io);

		expect(captured.stdout).toStrictEqual([`remove ${join(base, 'index', '0123456789abcdef')} (1.0 KB)`, 'Removed 1 target(s), 1.0 KB.']);
		expect(existsSync(join(base, 'index', '0123456789abcdef'))).toBe(false);
	});

	it('reports a failed removal on stderr and keeps the successful bytes', () => {
		const base = mkdtempSync(join(tmpdir(), 'codeindex-cleanup-presentation-'));
		const parent = join(base, 'locked');
		const child = join(parent, 'target');
		const captured = captureIo();

		mkdirSync(child, {recursive: true});
		chmodSync(parent, 0o500);

		try {
			expect(removeCleanupTargets([{path: child, bytes: 10}], captured.io)).toBe(0);
			expect(captured.stderr).toStrictEqual([expect.stringContaining('Failed to remove')]);
		} finally {
			chmodSync(parent, 0o700);
			rmSync(base, {recursive: true, force: true});
		}
	});

	it('formats byte magnitudes at every unit boundary', () => {
		expect(formatSize(0)).toBe('0 B');
		expect(formatSize(1023)).toBe('1023 B');
		expect(formatSize(1024)).toBe('1.0 KB');
		expect(formatSize(1024 * 1024 - 1)).toBe('1024.0 KB');
		expect(formatSize(1024 * 1024)).toBe('1.0 MB');
		expect(formatSize(1024 ** 3)).toBe('1.0 GB');
		expect(formatSize(1024 ** 4)).toBe('1.0 TB');
		expect(formatSize(1024 ** 5)).toBe('1024.0 TB');
		expect(formatSize(-1)).toBe('-1 B');
		expect(formatSize(Number.POSITIVE_INFINITY)).toBe('Infinity TB');
	});

	it('resolves default roots to the real index root and protects the working directory', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'codeindex-cleanup-roots-'));
		temporaryDirectories.push(cwd);

		expect(cleanupRootsOf(true, {}, cwd)).toStrictEqual({storage: indexRootDirectory(), databasePath: null, protectedPaths: [cwd]});
	});
});
