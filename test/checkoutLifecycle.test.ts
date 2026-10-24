import {cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {collectCleanupTargets, removeCleanupTargets, runCleanup} from '../src/core/cleanup.ts';
import {loadConfig} from '../src/core/config/config.ts';
import {cleanupRootsOf, runCli, type CliIoType} from '../src/transports/cli/runCli.ts';

const {dirname, join} = path;

type CapturedIoType = Readonly<{io: CliIoType; stdout: () => string; stderr: () => string}>;

const captureIo = (): CapturedIoType => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
		stdout: () => stdout.join('\n'),
		stderr: () => stderr.join('\n'),
	};
};

const temporaryDirectories: string[] = [];

const temporaryRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), 'codeindex-checkout-'));
	temporaryDirectories.push(root);
	return root;
};

const writeCheckout = (base: string, name: string, store: string): string => {
	const workspace = join(base, name);
	mkdirSync(join(workspace, 'src'), {recursive: true});
	writeFileSync(
		join(workspace, 'tsconfig.json'),
		`${JSON.stringify({compilerOptions: {target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true}, include: ['src/**/*']}, null, '\t')}\n`,
	);
	writeFileSync(join(workspace, 'src', 'main.ts'), 'export const value = 1;\nexport function read(): number {\n\treturn value;\n}\n');
	writeFileSync(
		join(workspace, 'codeindex.config.json'),
		`${JSON.stringify(
			{
				project: {name: 'lifecycle', id: 'pinned-project', root: '.'},
				extractor: {id: 'typescript', project: 'tsconfig.json'},
				storage: {directory: store, analyticsEnabled: false},
			},
			null,
			'\t',
		)}\n`,
	);
	return workspace;
};

const environmentOf = (workspace: string): NodeJS.ProcessEnv => ({
	CODE_INDEX_CONFIG: join(workspace, 'codeindex.config.json'),
	CODE_INDEX_LOG_LEVEL: 'error',
});

const configOf = (workspace: string): ReturnType<typeof loadConfig> => loadConfig(environmentOf(workspace));

const update = async (workspace: string): Promise<Readonly<{generationId: string; reused: boolean}>> => {
	const captured = captureIo();
	await expect(runCli(['update', '--json'], environmentOf(workspace), captured.io)).resolves.toBe(0);
	return JSON.parse(captured.stdout()) as Readonly<{generationId: string; reused: boolean}>;
};

const assertUpdateRefused = async (environment: NodeJS.ProcessEnv): Promise<void> => {
	const captured = captureIo();
	await expect(runCli(['update', '--json'], environment, captured.io)).resolves.toBe(1);
	expect(captured.stderr()).toContain('different working copy');
};

// The default scope needs the workspace configuration, which a deleted
// checkout took with it; --all is the recovery command.
const assertDefaultCleanFails = (workspace: string): void => {
	const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

	try {
		expect(runCleanup(['--yes'], (all) => cleanupRootsOf(all, environmentOf(workspace)))).toBe(1);
	} finally {
		stderr.mockRestore();
	}
};

const statusOf = async (workspace: string): Promise<Readonly<{generationId: string; scope: Readonly<{root: string; workingCopyId: string | null}>}>> => {
	const captured = captureIo();
	await expect(runCli(['status', '--json'], environmentOf(workspace), captured.io)).resolves.toBe(0);
	return JSON.parse(captured.stdout()) as Readonly<{generationId: string; scope: Readonly<{root: string; workingCopyId: string | null}>}>;
};

// Reads persisted identity without opening a writer, so the source stays untouched.
const readDatabase = (
	databasePath: string,
): Readonly<{generationId: string | null; fingerprint: string | null; lastSeenAt: string | null; workingCopyId: string | null}> => {
	const database = new DatabaseSync(databasePath, {readOnly: true});

	try {
		const generation = database.prepare("select id from generation where state = 'published'").get();
		const workingCopy = database.prepare('select id, last_seen_at from working_copy limit 1').get();
		const fingerprint = database.prepare("select value from metadata where key = 'workspace_fingerprint'").get();

		return {
			generationId: generation === undefined ? null : String(generation['id']),
			fingerprint: fingerprint === undefined ? null : String(fingerprint['value']),
			lastSeenAt: workingCopy === undefined ? null : String(workingCopy['last_seen_at']),
			workingCopyId: workingCopy === undefined ? null : String(workingCopy['id']),
		};
	} finally {
		database.close();
	}
};

describe('checkout lifecycle', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('gives a copy its own database, identity, and generation', async () => {
		const base = temporaryRoot();
		const store = join(base, 'store');
		const source = writeCheckout(base, 'source', store);
		const first = await update(source);
		const sourceConfig = configOf(source);
		const sourceStatus = await statusOf(source);
		const sourceDatabase = readDatabase(sourceConfig.databasePath);
		const copy = join(base, 'copy');

		cpSync(source, copy, {recursive: true});

		const copyConfig = configOf(copy);
		expect(copyConfig.projectId).toBe(sourceConfig.projectId);
		expect(copyConfig.databasePath).not.toBe(sourceConfig.databasePath);

		const copied = await update(copy);

		expect(copied.reused).toBe(false);
		expect(copied.generationId).not.toBe(first.generationId);

		const copiedStatus = await statusOf(copy);
		expect(copiedStatus.scope.root).toBe(realpathSync(copy));
		expect(copiedStatus.scope.workingCopyId).not.toBe(sourceStatus.scope.workingCopyId);
		expect(readDatabase(copyConfig.databasePath).generationId).toBe(copied.generationId);
		expect(readDatabase(sourceConfig.databasePath)).toStrictEqual(sourceDatabase);
	});

	it('rebuilds a moved checkout instead of serving the old root generation', async () => {
		const base = temporaryRoot();
		const store = join(base, 'store');
		const source = writeCheckout(base, 'source', store);
		const first = await update(source);
		const sourceConfig = configOf(source);
		const sourceStatus = await statusOf(source);
		const sourceDatabase = readDatabase(sourceConfig.databasePath);
		const moved = join(base, 'moved');

		renameSync(source, moved);

		const movedConfig = configOf(moved);
		expect(movedConfig.projectId).toBe(sourceConfig.projectId);
		expect(movedConfig.databasePath).not.toBe(sourceConfig.databasePath);

		const rebuilt = await update(moved);

		expect(rebuilt.reused).toBe(false);
		expect(rebuilt.generationId).not.toBe(first.generationId);

		const movedStatus = await statusOf(moved);
		expect(movedStatus.scope.root).toBe(realpathSync(moved));
		expect(movedStatus.generationId).toBe(rebuilt.generationId);
		expect(movedStatus.scope.workingCopyId).not.toBe(sourceStatus.scope.workingCopyId);
		expect(readDatabase(sourceConfig.databasePath)).toStrictEqual(sourceDatabase);
	});

	it('binds an explicitly shared database to one checkout across a copy and a move', async () => {
		const base = temporaryRoot();
		const shared = join(base, 'shared.sqlite');
		const first = writeCheckout(base, 'first', join(base, 'store'));
		const second = writeCheckout(base, 'second', join(base, 'store'));
		const sharedEnvironment = (workspace: string): NodeJS.ProcessEnv => ({
			CODE_INDEX_ROOT: workspace,
			CODE_INDEX_PROJECT_FILE: join(workspace, 'tsconfig.json'),
			CODE_INDEX_DATABASE: shared,
			CODE_INDEX_ANALYTICS: 'false',
			CODE_INDEX_LOG_LEVEL: 'error',
		});

		const built = captureIo();
		await expect(runCli(['update', '--json'], sharedEnvironment(first), built.io)).resolves.toBe(0);
		const published = readDatabase(shared);

		await assertUpdateRefused(sharedEnvironment(second));

		const moved = join(base, 'moved');
		renameSync(first, moved);

		await assertUpdateRefused(sharedEnvironment(moved));
		expect(readDatabase(shared)).toStrictEqual(published);
	});

	it('leaves a deleted checkout database cleanable without lease surgery', async () => {
		const base = temporaryRoot();
		const store = join(base, 'store');
		const workspace = writeCheckout(base, 'source', store);
		await update(workspace);
		const config = configOf(workspace);
		const projectDirectory = dirname(config.databasePath);

		// Simulate a process that exited without releasing its marker or lease.
		writeFileSync(
			join(projectDirectory, 'index.sqlite.owner-2147483647-deadbeef.json'),
			JSON.stringify({pid: 2_147_483_647, ownerId: 'dead-owner', startedAt: new Date().toISOString()}),
		);
		const crashed = new DatabaseSync(config.databasePath);
		const expired = new Date(Date.now() - 60_000).toISOString();
		crashed
			.prepare(
				`insert or replace into build_lease (project_id, owner_id, process_id, acquired_at, heartbeat_at, expires_at)
				 values (?, ?, ?, ?, ?, ?)`,
			)
			.run(config.projectId, 'dead-owner', 2_147_483_647, expired, expired, expired);
		crashed.close();

		rmSync(workspace, {recursive: true, force: true});
		assertDefaultCleanFails(workspace);

		const targets = collectCleanupTargets({storage: realpathSync(store), databasePath: null, protectedPaths: []}, {yes: true, all: true});

		expect(targets.map((target) => target.path)).toContain(projectDirectory);
		expect(removeCleanupTargets(targets)).toBeGreaterThan(0);
		expect(existsSync(projectDirectory)).toBe(false);
		expect(existsSync(config.databasePath)).toBe(false);
	});
});
