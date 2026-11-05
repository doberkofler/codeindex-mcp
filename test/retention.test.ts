import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {collectCleanupPlan, executeCleanup, type CleanupRootsType} from '../src/core/cleanup.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {schemaBackupPaths} from '../src/core/storage/schemaBackup.ts';
import {benchmarkCheckoutPlan, benchmarkResiduePlan} from '../src/core/retentionBenchmark.ts';
import {oracleEvidencePlan} from '../src/core/retentionEvidence.ts';
import {evaluationPlan} from '../src/core/retentionEvaluation.ts';

const {join} = path;
const temporaryDirectories: string[] = [];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const temporaryRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), 'codeindex-retention-'));
	temporaryDirectories.push(root);
	return root;
};

const writeFile = (filePath: string, content = 'x'): void => {
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, content);
};

const age = (target: string, days: number): void => {
	const when = new Date(Date.now() - days * DAY_MS);
	utimesSync(target, when, when);
};

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {cwd, encoding: 'utf8'});

const initRepository = (repository: string): void => {
	mkdirSync(repository, {recursive: true});
	git(repository, ['init', '-q']);
	writeFile(join(repository, 'file.txt'), 'initial\n');
	git(repository, ['add', '-A']);
	git(repository, ['-c', 'user.name=Retention', '-c', 'user.email=retention@example.invalid', 'commit', '-q', '-m', 'init']);
};

const storageRoot = (base: string): string => {
	const storage = join(base, 'store');
	mkdirSync(storage, {recursive: true});
	return storage;
};

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

const incompatibleDatabase = (databasePath: string, version: string): void => {
	const database = new DatabaseSync(databasePath);
	database.exec('create table if not exists metadata (key text primary key, value text not null)');
	database.prepare('insert or replace into metadata (key, value) values (?, ?)').run('schema_version', version);
	database.close();
};

describe('schema backup retention', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('leaves one recovery point across repeated schema upgrades', () => {
		const base = temporaryRoot();
		const databasePath = join(base, 'index.sqlite');
		writeFile(`${databasePath}.schema-0.bak`, 'older');

		for (const version of ['1', '2', '3']) {
			incompatibleDatabase(databasePath, version);
			const database = IndexDatabase.open(databasePath, {projectId: 'retention'});
			database.close();

			expect(schemaBackupPaths(databasePath)).toHaveLength(1);
			expect(existsSync(`${databasePath}.schema-${version}.bak`)).toBe(true);
			expect(existsSync(`${databasePath}.schema-0.bak`)).toBe(false);
		}
	});
});

describe('benchmark residue retention', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('removes stale residue by age and keeps recent residue', () => {
		const base = temporaryRoot();
		const stale = join(base, 'codeindex-benchmark-workspace-stale');
		const fresh = join(base, 'codeindex-benchmark-database-fresh');

		writeFile(join(stale, 'src', 'index.ts'));
		writeFile(join(fresh, 'index.sqlite'));
		age(stale, 2);

		const plan = benchmarkResiduePlan({temporaryDirectory: base, protectedPaths: [], now: new Date()});

		expect(plan.targets.map((target) => target.path)).toStrictEqual([stale]);
		expect(plan.retained.map((target) => target.path)).toStrictEqual([fresh]);
	});

	it('keeps only the newest entries when the count bound is exceeded', () => {
		const base = temporaryRoot();
		const paths = Array.from({length: 6}, (_, index) => {
			const directory = join(base, `codeindex-benchmark-workspace-${String(index)}`);
			writeFile(join(directory, 'src', 'index.ts'));
			age(directory, (6 - index) / 24);
			return directory;
		});

		const plan = benchmarkResiduePlan({temporaryDirectory: base, protectedPaths: [], now: new Date()});
		const removed = new Set(plan.targets.map((target) => target.path));

		expect(plan.targets).toHaveLength(2);
		expect(plan.retained).toHaveLength(4);
		expect(removed.has(paths[0] ?? '')).toBe(true);
		expect(removed.has(paths[1] ?? '')).toBe(true);
	});
});

describe('benchmark checkout lifecycle', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('retains prepared checkouts and removes unreferenced ones', () => {
		const base = temporaryRoot();
		const cacheRoot = join(base, 'cache');
		const projectsRoot = join(cacheRoot, 'projects');
		const prepared = join(projectsRoot, 'prepared');
		const stale = join(projectsRoot, 'stale');

		initRepository(prepared);
		initRepository(stale);
		writeFile(
			join(projectsRoot, 'prepare.json'),
			JSON.stringify({schemaVersion: 1, projects: [{name: 'prepared', directory: 'prepared', revision: git(prepared, ['rev-parse', 'HEAD']).trim()}]}),
		);

		const plan = benchmarkCheckoutPlan({cacheRoots: [cacheRoot], removeAll: false, protectedPaths: []});

		expect(plan.targets.map((target) => target.path)).toStrictEqual([stale]);
		expect(plan.retained.map((target) => target.path)).toStrictEqual([prepared]);
	});

	it('refuses dirty checkouts until discard is approved', () => {
		const base = temporaryRoot();
		const cacheRoot = join(base, 'cache');
		const checkout = join(cacheRoot, 'projects', 'dirty');

		initRepository(checkout);
		writeFile(join(checkout, 'file.txt'), 'modified\n');

		const refused = benchmarkCheckoutPlan({cacheRoots: [cacheRoot], removeAll: true, protectedPaths: []});
		expect(refused.refused.map((entry) => entry.reason)).toStrictEqual(['dirty_worktree']);

		const discarded = benchmarkCheckoutPlan({cacheRoots: [cacheRoot], removeAll: true, protectedPaths: [], discardDirty: true});
		expect(discarded.targets.map((target) => target.path)).toContain(checkout);
	});

	it('removes every prepared checkout only when explicitly requested', () => {
		const base = temporaryRoot();
		const cacheRoot = join(base, 'cache');
		const checkout = join(cacheRoot, 'projects', 'prepared');

		initRepository(checkout);
		writeFile(
			join(cacheRoot, 'projects', 'prepare.json'),
			JSON.stringify({projects: [{name: 'prepared', directory: 'prepared', revision: git(checkout, ['rev-parse', 'HEAD']).trim()}]}),
		);

		expect(benchmarkCheckoutPlan({cacheRoots: [cacheRoot], removeAll: false, protectedPaths: []}).targets).toStrictEqual([]);
		expect(benchmarkCheckoutPlan({cacheRoots: [cacheRoot], removeAll: true, protectedPaths: []}).targets.map((target) => target.path)).toContain(checkout);
	});
});

describe('Oracle evidence retention', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('retains the bundle a committed descriptor requires and removes superseded bundles', () => {
		const base = temporaryRoot();
		const storage = storageRoot(base);
		const required = join(storage, 'oracle-live', 'required');
		const superseded = join(storage, 'oracle-live', 'superseded');
		const descriptor = join(base, 'benchmark', 'oracle-production', 'corpus.json');

		writeFile(join(required, 'plan.json'));
		writeFile(join(superseded, 'plan.json'));
		writeFile(descriptor, JSON.stringify({schemaVersion: 1, evidence: {externalRoot: 'oracle-live/required'}}));

		const plan = oracleEvidencePlan({storageRoots: [storage], evidenceRoots: [], descriptorPaths: [descriptor], protectedPaths: []});

		expect(plan.targets.map((target) => target.path)).toStrictEqual([superseded]);
		expect(plan.retained.map((target) => target.path)).toStrictEqual([required]);
	});
});

describe('evaluation state retention', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('bounds workspaces by count and age and supersedes old reports', () => {
		const base = temporaryRoot();
		const state = join(base, 'state');
		const staleWorkspace = join(state, 'workspaces', 'stale');
		const freshWorkspace = join(state, 'workspaces', 'fresh');
		const database = join(state, 'databases', 'old.sqlite');
		const reports = Array.from({length: 7}, (_, index) => {
			const directory = join(state, 'results', `run-${String(index)}`);
			writeFile(join(directory, 'report.json'), '{}');
			age(directory, 7 - index);
			return directory;
		});

		writeFile(join(staleWorkspace, 'file.ts'));
		writeFile(join(freshWorkspace, 'file.ts'));
		writeFile(database, 'sqlite');
		age(staleWorkspace, 2);
		age(database, 2);

		const plan = evaluationPlan({evaluationRoots: [state], protectedPaths: [], now: new Date()});
		const removed = new Set(plan.targets.map((target) => target.path));

		expect(removed.has(staleWorkspace)).toBe(true);
		expect(removed.has(freshWorkspace)).toBe(false);
		expect(removed.has(database)).toBe(true);
		expect(removed.has(reports[0] ?? '')).toBe(true);
		expect(removed.has(reports[1] ?? '')).toBe(true);
		expect(removed.has(reports[6] ?? '')).toBe(false);
	});
});

const rootsOf = (base: string): CleanupRootsType => {
	const storage = storageRoot(base);

	return {
		storage,
		databasePath: null,
		protectedPaths: [join(base, 'protected')],
		repository: join(base, 'repository'),
		temporaryDirectory: base,
		cacheRoots: [join(base, 'cache')],
		evidenceRoots: [join(base, 'evidence')],
		evaluationRoots: [join(base, 'evaluation')],
		oracleBundleDescriptors: [],
	};
};

describe('cleanup convergence and worktree registrations', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('converges across repeated create and cleanup cycles', () => {
		const base = temporaryRoot();
		const roots = rootsOf(base);

		for (let cycle = 0; cycle < 3; cycle += 1) {
			const workspace = join(base, `codeindex-benchmark-workspace-${String(cycle)}`);
			writeFile(join(workspace, 'src', 'index.ts'));
			age(workspace, 2);

			const plan = collectCleanupPlan(roots, {yes: true, all: true});
			expect(plan.targets.map((target) => target.path)).toContain(workspace);
			executeCleanup({yes: true, all: true}, () => roots, captureIo().io);
			expect(existsSync(workspace)).toBe(false);
		}

		expect(collectCleanupPlan(roots, {yes: true, all: true}).targets).toStrictEqual([]);
	});

	it('removes an evaluation worktree and leaves no stale registration', () => {
		const base = temporaryRoot();
		const roots = rootsOf(base);
		const repository = roots.repository ?? '';
		const worktree = join(base, 'evaluation', 'workspaces', 'detached');

		initRepository(repository);
		git(repository, ['worktree', 'add', '--detach', worktree]);
		age(worktree, 2);

		const captured = captureIo();
		executeCleanup({yes: true, all: true}, () => roots, captured.io);

		expect(existsSync(worktree)).toBe(false);
		expect(git(repository, ['worktree', 'list', '--porcelain'])).not.toContain(worktree);
		expect(captured.stdout.join('\n')).toContain('remove ');
	});

	it('reports retained bundles and declined categories', () => {
		const base = temporaryRoot();
		const roots = rootsOf(base);
		const required = join(roots.storage, 'oracle-live', 'required');
		const descriptor = join(base, 'benchmark', 'oracle-production', 'corpus.json');

		writeFile(join(required, 'plan.json'));
		writeFile(descriptor, JSON.stringify({evidence: {externalRoot: 'oracle-live/required'}}));
		const configured: CleanupRootsType = {...roots, oracleBundleDescriptors: [descriptor]};

		const captured = captureIo();
		executeCleanup({yes: false, all: true}, () => configured, captured.io);
		const output = captured.stdout.join('\n');

		expect(output).toContain(`retain ${required} (required_bundle)`);
		expect(output).toContain('decline repository_output');
	});
});
