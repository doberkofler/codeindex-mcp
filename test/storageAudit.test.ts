import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {auditStorage} from '../src/core/storageAudit.ts';
import {discoverStorageAuditRoots, normalizeAuditPath} from '../src/core/storageAuditRoots.ts';
import {type StorageAuditCategoryType} from '../src/core/storageAuditTypes.ts';
import {runStorageAuditCommand} from '../src/transports/cli/storageAuditCommand.ts';

const {join} = path;
const temporaryDirectories: string[] = [];

const temporaryDirectory = (label: string): string => {
	const directory = mkdtempSync(join(tmpdir(), `codeindex-storage-audit-${label}-`));
	temporaryDirectories.push(directory);

	return directory;
};

const write = (filePath: string, bytes: number): void => {
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, 'x'.repeat(bytes));
};

type FixtureType = Readonly<{
	base: string;
	home: string;
	repository: string;
	temporary: string;
	project: string;
	customProject: string;
	opencode: string;
}>;

const createFixture = (): FixtureType => {
	const base = temporaryDirectory('fixture');
	const home = join(base, 'home');
	const repository = join(base, 'repo');
	const temporary = join(base, 'tmp');
	const project = join(home, '.local', 'share', 'codeindex-mcp', '0123456789abcdef');
	const customProject = join(repository, 'custom-storage', 'abcdef0123456789');

	mkdirSync(project, {recursive: true});
	mkdirSync(temporary, {recursive: true});
	mkdirSync(repository, {recursive: true});
	mkdirSync(join(base, 'unrelated'), {recursive: true});

	write(join(project, 'index.sqlite'), 2048);
	write(join(project, 'index.sqlite-wal'), 128);
	write(join(project, 'index.sqlite.schema-16.bak'), 256);
	write(join(project, 'analytics', 'events.jsonl'), 512);
	write(join(project, 'unclassified.bin'), 999);
	write(join(home, '.local', 'share', 'codeindex-mcp', 'oracle-live', 'project-a', 'report.json'), 300);
	write(join(customProject, 'index.sqlite'), 110);
	write(join(home, '.cache', 'codeindex-benchmark', 'projects', 'pinned', 'file.ts'), 400);
	write(join(home, 'codeindex-evidence', 'suite-a', 'summary.md'), 100);
	write(join(temporary, 'codeindex-benchmark-workspace-a', 'src', 'index.ts'), 50);
	write(join(temporary, 'codeindex-evaluation', 'state-hash', 'workspaces', 'run', 'file.ts'), 70);
	write(join(repository, 'dist', 'cli.mjs'), 10);
	write(join(repository, 'coverage', 'lcov.info'), 20);
	write(join(repository, 'benchmark', 'results', 'run.json'), 30);
	write(join(repository, 'evaluation', 'artifacts', 'artifact.json'), 40);
	write(join(repository, 'evaluation', 'results', 'result.json'), 50);
	write(join(repository, 'evaluation', 'workspaces', 'candidate', 'file.ts'), 60);
	write(join(repository, 'evaluation', 'harness', 'harness.json'), 70);
	write(join(repository, 'release-artifacts', 'codeindex.tgz'), 80);
	write(join(repository, '.oracle-antlr-benchmark-a', 'run.json'), 90);
	write(join(repository, 'build.tsbuildinfo'), 15);
	write(join(repository, '.vite', 'cache.bin'), 25);
	writeFileSync(join(repository, 'codeindex.config.json'), JSON.stringify({storage: {directory: 'custom-storage'}}));
	writeFileSync(join(repository, 'package.json'), JSON.stringify({name: 'fixture', private: true}));

	const opencode = join(home, '.local', 'share', 'opencode', 'sessions', 'session.json');

	write(opencode, 777);

	return {base, home, repository, temporary, project, customProject, opencode};
};

const categoryOf = (report: ReturnType<typeof auditStorage>, category: StorageAuditCategoryType): ReturnType<typeof auditStorage>['categories'][number] =>
	report.categories.find((entry) => entry.category === category) ?? {
		category,
		bytes: 0,
		logicalBytes: 0,
		rawKiB: 0,
		files: 0,
		entries: 0,
	};

const removeTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {cwd, encoding: 'utf8'});

describe('storage audit inventory', () => {
	afterEach(removeTemporaryDirectories);

	it('classifies only known categories without double-counting nested paths', () => {
		const fixture = createFixture();
		const report = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}});

		expect(categoryOf(report, 'index_database').logicalBytes).toBe(2286);
		expect(categoryOf(report, 'analytics').logicalBytes).toBe(512);
		expect(categoryOf(report, 'schema_backup').logicalBytes).toBe(256);
		expect(categoryOf(report, 'evidence_bundle').logicalBytes).toBe(400);
		expect(categoryOf(report, 'benchmark_cache').logicalBytes).toBe(570);
		expect(categoryOf(report, 'evaluation_state').logicalBytes).toBe(290);
		expect(categoryOf(report, 'repository_output').logicalBytes).toBe(150);
		expect(report.totals.logicalBytes).toBe(4464);
		expect(report.totals.logicalBytes).toBe(report.categories.reduce((total, category) => total + category.logicalBytes, 0));
	});

	it('normalizes paths to $HOME and $REPO and never inspects OpenCode sessions', () => {
		const fixture = createFixture();
		const report = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}});
		const paths = report.entries.map((entry) => entry.path);

		expect(paths).toContain('$HOME/.local/share/codeindex-mcp/0123456789abcdef');
		expect(paths).toContain('$HOME/.local/share/codeindex-mcp/0123456789abcdef/analytics');
		expect(paths).toContain('$REPO/dist');
		expect(paths).toContain('$REPO/coverage');
		expect(paths.some((entry) => entry.includes('opencode'))).toBe(false);
		expect(paths.some((entry) => entry.includes(realpathSync(fixture.home)))).toBe(false);
		expect(paths.some((entry) => entry.includes(realpathSync(fixture.repository)))).toBe(false);
	});

	it('ignores unclassified files inside a managed project', () => {
		const fixture = createFixture();
		const report = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}});

		expect(report.entries.some((entry) => entry.path.endsWith('unclassified.bin'))).toBe(false);
		expect(report.entries.reduce((total, entry) => total + entry.logicalBytes, 0)).toBe(4464);
	});

	it('marks active owner projects ineligible immediately before reporting', () => {
		const fixture = createFixture();
		writeFileSync(
			join(fixture.project, `index.sqlite.owner-${String(process.pid)}-deadbeef.json`),
			JSON.stringify({pid: process.pid, ownerId: 'owner', startedAt: new Date().toISOString()}),
		);

		const report = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}});
		const owned = report.entries.filter((entry) => entry.path.startsWith('$HOME/.local/share/codeindex-mcp/0123456789abcdef'));

		expect(report.activeOwners).toHaveLength(1);
		expect(report.activeOwners[0]?.pid).toBe(process.pid);
		expect(owned.length).toBeGreaterThan(0);
		expect(owned.every((entry) => !entry.cleanupEligible)).toBe(true);
		expect(owned.every((entry) => entry.reason === 'active_owner')).toBe(true);
		expect(report.entries.filter((entry) => entry.category === 'repository_output').every((entry) => entry.cleanupEligible)).toBe(true);
	});

	it('produces the same normalized inventory for unchanged state', () => {
		const fixture = createFixture();
		const now = new Date('2026-11-03T00:00:00.000Z');
		const first = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}, now});
		const second = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}, now});

		expect(second.inventorySha256).toBe(first.inventorySha256);
		expect(second.entries).toStrictEqual(first.entries);
		expect(second.generatedAt).toBe('2026-11-03T00:00:00.000Z');
	});

	it('discovers XDG roots and configured storage without scanning OpenCode storage', () => {
		const fixture = createFixture();
		const roots = discoverStorageAuditRoots({
			home: fixture.home,
			repository: fixture.repository,
			temporaryDirectory: fixture.temporary,
			environment: {XDG_DATA_HOME: join(fixture.base, 'xdg-data'), XDG_CACHE_HOME: join(fixture.base, 'xdg-cache')},
		});

		expect(roots.storageRoots).toContain(join(fixture.base, 'xdg-data', 'codeindex-mcp'));
		expect(roots.storageRoots).toContain(join(realpathSync(fixture.repository), 'custom-storage'));
		expect(roots.cacheRoots).toContain(join(fixture.base, 'xdg-cache', 'codeindex-benchmark'));
		expect(roots.storageRoots.join('\n')).not.toContain('opencode');
	});

	it('discovers explicit evidence and evaluation roots from the environment', () => {
		const fixture = createFixture();
		const evidence = join(fixture.base, 'external-evidence');
		const evaluation = join(fixture.base, 'external-evaluation');

		write(join(evidence, 'bundle', 'report.json'), 33);
		write(join(evaluation, 'run', 'artifact.json'), 44);

		const report = auditStorage({
			home: fixture.home,
			repository: fixture.repository,
			temporaryDirectory: fixture.temporary,
			environment: {CODEINDEX_EVIDENCE_ROOT: evidence, EVALUATION_STATE_ROOT: evaluation},
		});

		expect(report.entries).toContainEqual(
			expect.objectContaining({category: 'evidence_bundle', path: join(realpathSync(fixture.base), 'external-evidence', 'bundle')}),
		);
		expect(report.entries).toContainEqual(
			expect.objectContaining({category: 'evaluation_state', path: join(realpathSync(fixture.base), 'external-evaluation')}),
		);
		expect(report.totals.logicalBytes).toBe(4464 + 33 + 44);
	});

	it('normalizes paths only below the repository or home prefix', () => {
		const fixture = createFixture();

		expect(normalizeAuditPath(join(fixture.repository, 'dist'), {home: fixture.home, repository: fixture.repository})).toBe('$REPO/dist');
		expect(normalizeAuditPath(join(fixture.home, '.cache'), {home: fixture.home, repository: fixture.repository})).toBe('$HOME/.cache');
		expect(normalizeAuditPath('/opt/elsewhere', {home: fixture.home, repository: fixture.repository})).toBe('/opt/elsewhere');
	});
});

describe('storage audit write-ahead log', () => {
	afterEach(removeTemporaryDirectories);

	it('reports database, WAL, shared-memory, and the applied bound per index', () => {
		const fixture = createFixture();
		const report = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}});

		expect(report.wal.databases).toHaveLength(2);
		expect(report.wal.databaseBytes).toBe(2048 + 110);
		expect(report.wal.walBytes).toBe(128);
		expect(report.wal.shmBytes).toBe(0);
		expect(report.wal.withinLimit).toBe(true);
		expect(report.wal.databases.every((database) => database.walBytes <= database.limitBytes)).toBe(true);
		expect(report.wal.policy.maxDatabaseFraction).toBe(0.1);
	});
});

describe('storage audit Git reporting', () => {
	afterEach(removeTemporaryDirectories);

	it('reports dirty worktrees separately and never marks them removable', () => {
		const fixture = createFixture();
		const worktree = join(fixture.base, 'dirty-worktree');

		git(fixture.repository, ['init', '-q']);
		git(fixture.repository, ['add', '-A']);
		git(fixture.repository, ['-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-q', '-m', 'init']);
		git(fixture.repository, ['worktree', 'add', '-q', worktree]);
		write(join(worktree, 'dirty.txt'), 10);

		const report = auditStorage({home: fixture.home, repository: fixture.repository, temporaryDirectory: fixture.temporary, environment: {}});
		const dirty = report.worktrees.find((entry) => entry.state === 'dirty');

		expect(report.worktrees).toHaveLength(2);
		expect(dirty?.path).toBe(join(realpathSync(fixture.base), 'dirty-worktree'));
		expect(dirty?.removable).toBe(false);
		expect(report.git.worktreeCount).toBe(2);
		expect(report.git.dirtyWorktreeCount).toBe(1);
		expect(report.git.directoryBytes).toBeGreaterThan(0);
		expect(report.totals.bytes).toBe(report.categories.reduce((total, category) => total + category.bytes, 0));
	});
});

describe('storage audit command', () => {
	afterEach(removeTemporaryDirectories);

	it('renders a concise human summary and JSON', () => {
		const fixture = createFixture();
		const environment = {HOME: fixture.home, TMPDIR: fixture.temporary};
		const text: string[] = [];
		const json: string[] = [];

		expect(
			runStorageAuditCommand(['--repo', fixture.repository], environment, {
				stdout: (line) => {
					text.push(line);
				},
				stderr: () => undefined,
			}),
		).toBe(0);
		expect(
			runStorageAuditCommand(['--repo', fixture.repository, '--json'], environment, {
				stdout: (line) => {
					json.push(line);
				},
				stderr: () => undefined,
			}),
		).toBe(0);

		const report = JSON.parse(json.join('\n')) as {readonly categories: readonly unknown[]};

		expect(text.join('\n')).toContain('Storage audit:');
		expect(text.join('\n')).toContain('size semantics:');
		expect(text.join('\n')).toContain('reported separately');
		expect(text.join('\n')).toContain('wal policy:');
		expect(text.join('\n')).toContain('within bound');
		expect(report.categories).toHaveLength(7);
	});

	it('writes usage diagnostics to stderr and rejects unknown options', () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const io = {
			stdout: (line: string): void => {
				stdout.push(line);
			},
			stderr: (line: string): void => {
				stderr.push(line);
			},
		};

		expect(runStorageAuditCommand(['--help'], {}, io)).toBe(0);
		expect(stdout.join('\n')).toContain('Usage: codeindex-cli audit');
		expect(runStorageAuditCommand(['--unknown'], {}, io)).toBe(1);
		expect(stderr.join('\n')).toContain('unknown option');
	});

	it('does not mutate discovered state', () => {
		const fixture = createFixture();
		const before = existsSync(join(fixture.project, 'index.sqlite'));

		runStorageAuditCommand(['--repo', fixture.repository], {HOME: fixture.home, TMPDIR: fixture.temporary}, {stdout: () => undefined, stderr: () => undefined});

		expect(existsSync(join(fixture.project, 'index.sqlite'))).toBe(before);
		expect(existsSync(join(fixture.repository, 'dist', 'cli.mjs'))).toBe(true);
	});
});
