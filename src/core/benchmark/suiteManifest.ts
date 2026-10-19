import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {PROGRAM_VERSION} from '../version.ts';
import {type BenchmarkSuitePublicProjectType} from './suiteTypes.ts';

const GIT_TIMEOUT_MS = 60_000;

const StepResultSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(['generated', 'public', 'reference']),
	title: z.string().min(1),
	status: z.enum(['passed', 'failed', 'skipped']),
	exitCode: z.number().int(),
	durationMs: z.number().min(0),
	artifacts: z.array(z.string()),
	detail: z.string().nullable(),
});

const IdentitySchema = z.object({
	commit: z.string().min(1),
	dirty: z.boolean(),
	statusSha256: z.string().min(1),
	cliSha256: z.string().min(1),
	version: z.string().min(1),
	nodeVersion: z.string().min(1),
	sqliteVersion: z.string().min(1),
	platform: z.string().min(1),
	arch: z.string().min(1),
	cpuModel: z.string().min(1),
	totalMemoryBytes: z.number().int().positive(),
});

const ProjectIdentitySchema = z.object({
	name: z.string().min(1),
	directory: z.string().min(1),
	repository: z.string().min(1),
	revision: z.string().min(1),
	lockfileSha256: z.string().nullable(),
});

const SuiteManifestSchema = z.object({
	schemaVersion: z.literal(1),
	suite: z.object({
		id: z.string().min(1),
		path: z.string().min(1),
		sha256: z.string().min(1),
	}),
	identity: IdentitySchema,
	startedAt: z.string().min(1),
	completedAt: z.string().nullable(),
	status: z.enum(['running', 'passed', 'failed']),
	baselines: z.array(z.object({path: z.string().min(1), sha256: z.string().min(1)})),
	projects: z.array(ProjectIdentitySchema),
	steps: z.array(StepResultSchema),
});

export type SuiteManifestType = z.infer<typeof SuiteManifestSchema>;
export type SuiteStepResultType = z.infer<typeof StepResultSchema>;
export type SuiteIdentityType = z.infer<typeof IdentitySchema>;
export type ProjectIdentityType = z.infer<typeof ProjectIdentitySchema>;

export const sha256File = (filePath: string): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');
const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex');

export const git = (cwd: string, args: readonly string[]): string | null => {
	const result = spawnSync('git', [...args], {cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS});

	return result.status === 0 ? result.stdout.trim() : null;
};

export const repositoryRootOf = (cwd: string): string => git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;

const sqliteVersionOf = (): string => {
	const database = new DatabaseSync(':memory:');

	try {
		const row = database.prepare('select sqlite_version() as version').get();
		return row === undefined ? 'unknown' : String(row['version']);
	} finally {
		database.close();
	}
};

export const identityOf = (input: Readonly<{repositoryRoot: string; cliPath: string}>): SuiteIdentityType => {
	const status = git(input.repositoryRoot, ['status', '--porcelain']) ?? '';

	return {
		commit: git(input.repositoryRoot, ['rev-parse', 'HEAD']) ?? 'unknown',
		dirty: status !== '',
		statusSha256: sha256Text(status),
		cliSha256: sha256File(input.cliPath),
		version: PROGRAM_VERSION,
		nodeVersion: process.version,
		sqliteVersion: sqliteVersionOf(),
		platform: process.platform,
		arch: process.arch,
		cpuModel: os.cpus().at(0)?.model ?? 'unknown',
		totalMemoryBytes: os.totalmem(),
	};
};

export const sameIdentity = (left: SuiteIdentityType, right: SuiteIdentityType): boolean =>
	left.commit === right.commit &&
	left.statusSha256 === right.statusSha256 &&
	left.cliSha256 === right.cliSha256 &&
	left.platform === right.platform &&
	left.arch === right.arch &&
	left.cpuModel === right.cpuModel;

export const lockfileOf = (directory: string): string | null =>
	['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].map((name) => path.join(directory, name)).find((filePath) => existsSync(filePath)) ?? null;

/**
 * Verifies that a public project is checked out at the pinned revision.
 *
 * @param input - Configured project and resolved checkout root.
 * @returns Recorded project identity.
 * @throws {@link Error} When the checkout is missing or at another revision.
 */
export const verifyPublicProject = (input: Readonly<{entry: BenchmarkSuitePublicProjectType; projectsRoot: string}>): ProjectIdentityType => {
	const directory = path.join(input.projectsRoot, input.entry.directory);

	if (!existsSync(directory)) {
		throw new Error(`Public project ${input.entry.name} is not prepared at ${directory}; run "codeindex-cli benchmark-prepare --suite <suite>" first`);
	}

	const revision = git(directory, ['rev-parse', 'HEAD']);

	if (revision !== input.entry.revision) {
		throw new Error(
			`Public project ${input.entry.name} is at ${revision ?? 'unknown'}, expected ${input.entry.revision}; remove ${directory} and re-run benchmark-prepare`,
		);
	}

	const lockfile = lockfileOf(directory);

	return {
		name: input.entry.name,
		directory: input.entry.directory,
		repository: input.entry.repository,
		revision: input.entry.revision,
		lockfileSha256: lockfile === null ? null : sha256File(lockfile),
	};
};

export const artifactsExist = (outputDir: string, artifacts: readonly string[]): boolean =>
	artifacts.every((artifact) => existsSync(path.resolve(outputDir, artifact)));

export const readManifest = (outputDir: string): SuiteManifestType => {
	const parsed: unknown = JSON.parse(readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
	const result = SuiteManifestSchema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid suite manifest in ${outputDir}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

export const writeManifest = (outputDir: string, manifest: SuiteManifestType): void => {
	const filePath = path.join(outputDir, 'manifest.json');
	const temporaryPath = `${filePath}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {encoding: 'utf8'});
	renameSync(temporaryPath, filePath);
};
