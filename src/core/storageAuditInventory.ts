import {existsSync, readdirSync, statSync, type Dirent} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {activeProcessOwnersInDirectory, type ActiveProcessOwnerType} from './storage/processOwnership.ts';
import {normalizeAuditPath} from './storageAuditRoots.ts';
import {
	type StorageAuditCategoryType,
	type StorageAuditEntryType,
	type StorageAuditInventoryType,
	type StorageAuditReasonType,
	type StorageAuditRootsType,
	type StorageAuditWorktreeType,
} from './storageAuditTypes.ts';

const {basename, join} = path;

const INDEX_DIRECTORY_PATTERN = /^[0-9a-f]{16}$/u;
const DATABASE_NAME = 'index.sqlite';
const EVIDENCE_DIRECTORY = 'oracle-live';
const GIT_TIMEOUT_MS = 10_000;

type InternalEntryType = {
	readonly category: StorageAuditCategoryType;
	readonly absolutePath: string;
	readonly bytes: number;
	readonly logicalBytes: number;
	readonly files: number;
	readonly projectDirectory: string | null;
	cleanupEligible: boolean;
	reason: StorageAuditReasonType | null;
};

type FileSizeType = Readonly<{bytes: number; logicalBytes: number}>;
type FootprintType = Readonly<{bytes: number; logicalBytes: number; files: number}>;

const fileSize = (filePath: string): FileSizeType => {
	const stats = statSync(filePath);
	// APFS reports allocated blocks; logical size understates disk use when
	// compression or sparse files are present. Other platforms fall back to size.
	const allocatedBytes = process.platform === 'darwin' ? stats.blocks * 512 : stats.size;

	return {bytes: allocatedBytes > 0 ? allocatedBytes : stats.size, logicalBytes: stats.size};
};

const footprintOfFiles = (files: readonly string[]): FootprintType =>
	files.reduce<FootprintType>(
		(total, filePath) => {
			try {
				const size = fileSize(filePath);

				return {
					bytes: total.bytes + size.bytes,
					logicalBytes: total.logicalBytes + size.logicalBytes,
					files: total.files + 1,
				};
			} catch {
				// A file that disappears between listing and stat contributes nothing.
				return total;
			}
		},
		{bytes: 0, logicalBytes: 0, files: 0},
	);

const walkFiles = (directory: string, visit: (filePath: string) => void, skipDirectory: (name: string) => boolean = () => false): void => {
	let entries: readonly Dirent[];

	try {
		entries = readdirSync(directory, {withFileTypes: true});
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = join(directory, entry.name);

		if (entry.isSymbolicLink()) {
			continue;
		}

		if (entry.isDirectory()) {
			if (!skipDirectory(entry.name)) {
				walkFiles(entryPath, visit, skipDirectory);
			}

			continue;
		}

		if (entry.isFile()) {
			visit(entryPath);
		}
	}
};

const footprintOfDirectory = (directory: string): FootprintType => {
	if (!existsSync(directory)) {
		return {bytes: 0, logicalBytes: 0, files: 0};
	}

	if (!statSync(directory).isDirectory()) {
		return footprintOfFiles([directory]);
	}

	const files: string[] = [];
	walkFiles(directory, (filePath) => {
		files.push(filePath);
	});

	return footprintOfFiles(files);
};

const directFilesOf = (directory: string): readonly string[] => {
	try {
		return readdirSync(directory, {withFileTypes: true})
			.filter((entry) => entry.isFile() && !entry.isSymbolicLink())
			.map((entry) => join(directory, entry.name));
	} catch {
		return [];
	}
};

const childDirectoriesOf = (directory: string): readonly string[] => {
	try {
		return readdirSync(directory, {withFileTypes: true})
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => join(directory, entry.name));
	} catch {
		return [];
	}
};

const isIndexArtifact = (name: string): boolean => name === DATABASE_NAME || name.startsWith(`${DATABASE_NAME}-`) || name.startsWith(`${DATABASE_NAME}.owner-`);
const isSchemaBackup = (name: string): boolean => name.startsWith(`${DATABASE_NAME}.schema-`) && name.endsWith('.bak');

const entryOf = (
	category: StorageAuditCategoryType,
	absolutePath: string,
	footprint: FootprintType,
	projectDirectory: string | null = null,
): InternalEntryType => ({
	category,
	absolutePath,
	bytes: footprint.bytes,
	logicalBytes: footprint.logicalBytes,
	files: footprint.files,
	projectDirectory,
	cleanupEligible: true,
	reason: null,
});

const indexEntriesOf = (projectDirectory: string): readonly InternalEntryType[] => {
	const files = directFilesOf(projectDirectory);
	const indexFiles = files.filter((filePath) => isIndexArtifact(basename(filePath)));
	const backupFiles = files.filter((filePath) => isSchemaBackup(basename(filePath)));
	const analyticsDirectory = join(projectDirectory, 'analytics');
	const entries: InternalEntryType[] = [];

	if (indexFiles.length > 0) {
		entries.push(entryOf('index_database', projectDirectory, footprintOfFiles(indexFiles), projectDirectory));
	}

	if (existsSync(analyticsDirectory)) {
		entries.push(entryOf('analytics', analyticsDirectory, footprintOfDirectory(analyticsDirectory), projectDirectory));
	}

	if (backupFiles.length > 0) {
		entries.push(entryOf('schema_backup', projectDirectory, footprintOfFiles(backupFiles), projectDirectory));
	}

	return entries;
};

const isProjectDirectory = (target: string, name: string): boolean => INDEX_DIRECTORY_PATTERN.test(name) || existsSync(join(target, DATABASE_NAME));

const bundleEntriesOf = (root: string, category: StorageAuditCategoryType): readonly InternalEntryType[] =>
	childDirectoriesOf(root).map((directory) => entryOf(category, directory, footprintOfDirectory(directory)));

const storageEntriesOf = (storageRoot: string): readonly InternalEntryType[] =>
	childDirectoriesOf(storageRoot).flatMap((directory) => {
		const name = basename(directory);

		if (name === EVIDENCE_DIRECTORY) {
			return bundleEntriesOf(directory, 'evidence_bundle');
		}

		return isProjectDirectory(directory, name) ? indexEntriesOf(directory) : [];
	});

const temporaryEntriesOf = (temporaryDirectory: string): readonly InternalEntryType[] =>
	childDirectoriesOf(temporaryDirectory).flatMap((directory) => {
		const name = basename(directory);

		if (name.startsWith('codeindex-benchmark-workspace-') || name.startsWith('codeindex-benchmark-database-')) {
			return [entryOf('benchmark_cache', directory, footprintOfDirectory(directory))];
		}

		return [];
	});

const repositoryEntriesOf = (repository: string): readonly InternalEntryType[] => {
	const known: readonly (readonly [StorageAuditCategoryType, string])[] = [
		['repository_output', 'dist'],
		['repository_output', 'coverage'],
		['repository_output', 'release-artifacts'],
		['repository_output', '.vite'],
		['benchmark_cache', join('benchmark', 'results')],
		['evaluation_state', join('evaluation', 'artifacts')],
		['evaluation_state', join('evaluation', 'results')],
		['evaluation_state', join('evaluation', 'workspaces')],
	];
	const entries = known.flatMap(([category, relativePath]) => {
		const target = join(repository, relativePath);

		return existsSync(target) ? [entryOf(category, target, footprintOfDirectory(target))] : [];
	});
	const harnessRecord = join(repository, 'evaluation', 'harness', 'harness.json');

	return [...entries, ...(existsSync(harnessRecord) ? [entryOf('evaluation_state', harnessRecord, footprintOfFiles([harnessRecord]))] : [])];
};

const oracleBenchmarkEntriesOf = (repository: string): readonly InternalEntryType[] =>
	childDirectoriesOf(repository)
		.filter((directory) => basename(directory).startsWith('.oracle-antlr-benchmark-'))
		.map((directory) => entryOf('benchmark_cache', directory, footprintOfDirectory(directory)));

const typeScriptBuildInfoEntriesOf = (repository: string): readonly InternalEntryType[] => {
	const files: string[] = [];
	const skipped = new Set(['node_modules', '.git', '.vite', 'dist', 'coverage', 'release-artifacts', 'results', 'artifacts', 'workspaces']);
	walkFiles(
		repository,
		(filePath) => {
			if (basename(filePath).endsWith('.tsbuildinfo')) {
				files.push(filePath);
			}
		},
		(name) => skipped.has(name) || name.startsWith('.oracle-antlr-benchmark-'),
	);

	return files.map((filePath) => entryOf('repository_output', filePath, footprintOfFiles([filePath])));
};

const collectEntries = (roots: StorageAuditRootsType): readonly InternalEntryType[] => {
	const entries = [
		...roots.storageRoots.flatMap((root) => storageEntriesOf(root)),
		...roots.cacheRoots.flatMap((root) => (existsSync(root) ? [entryOf('benchmark_cache', root, footprintOfDirectory(root))] : [])),
		...roots.evidenceRoots.flatMap((root) => bundleEntriesOf(root, 'evidence_bundle')),
		...roots.evaluationRoots.flatMap((root) => (existsSync(root) ? [entryOf('evaluation_state', root, footprintOfDirectory(root))] : [])),
		...temporaryEntriesOf(roots.temporaryDirectory),
		...repositoryEntriesOf(roots.repository),
		...oracleBenchmarkEntriesOf(roots.repository),
		...typeScriptBuildInfoEntriesOf(roots.repository),
	];

	return entries.sort((left, right) => left.category.localeCompare(right.category) || left.absolutePath.localeCompare(right.absolutePath));
};

const gitOutput = (cwd: string, args: readonly string[]): string | null => {
	const result = spawnSync('git', [...args], {cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS});

	return result.status === 0 ? result.stdout.trim() : null;
};

type ParsedWorktreeType = Readonly<{path: string; head: string | null; branch: string | null}>;

const parseWorktrees = (porcelain: string): readonly ParsedWorktreeType[] =>
	porcelain
		.split(/\n{2,}/u)
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.map((block) => {
			let worktreePath: string | null = null;
			let head: string | null = null;
			let branch: string | null = null;

			for (const line of block.split('\n')) {
				if (line.startsWith('worktree ')) {
					worktreePath = line.slice('worktree '.length);
				} else if (line.startsWith('HEAD ')) {
					head = line.slice('HEAD '.length);
				} else if (line.startsWith('branch ')) {
					branch = line.slice('branch '.length);
				}
			}

			return worktreePath === null ? null : {path: worktreePath, head, branch};
		})
		.filter((worktree): worktree is ParsedWorktreeType => worktree !== null);

const worktreeStateOf = (worktreePath: string): StorageAuditWorktreeType['state'] => {
	const status = gitOutput(worktreePath, ['status', '--porcelain']);

	if (status === null) {
		return 'unknown';
	}

	return status.length === 0 ? 'clean' : 'dirty';
};

const worktreesOf = (roots: StorageAuditRootsType): readonly StorageAuditWorktreeType[] => {
	const porcelain = gitOutput(roots.repository, ['worktree', 'list', '--porcelain']);

	if (porcelain === null) {
		return [];
	}

	return parseWorktrees(porcelain).map((worktree) => ({
		path: normalizeAuditPath(worktree.path, roots),
		head: worktree.head,
		branch: worktree.branch,
		state: worktreeStateOf(worktree.path),
		removable: false,
	}));
};

/**
 * Re-evaluates owner markers immediately before eligibility is reported.
 *
 * Collection and reporting are separated deliberately: a process may start
 * between the inventory walk and the report, and the audit must not claim that
 * an actively owned index is cleanable.
 *
 * @param entries - Mutable internal entries collected by the inventory walk.
 * @returns Active owners found in their owning project directories.
 */
const refreshEligibility = (entries: readonly InternalEntryType[]): readonly ActiveProcessOwnerType[] => {
	const ownersByProject = new Map<string, readonly ActiveProcessOwnerType[]>();
	const owners: ActiveProcessOwnerType[] = [];

	for (const entry of entries) {
		if (entry.projectDirectory === null) {
			continue;
		}

		let projectOwners = ownersByProject.get(entry.projectDirectory);

		if (projectOwners === undefined) {
			projectOwners = activeProcessOwnersInDirectory(entry.projectDirectory);
			ownersByProject.set(entry.projectDirectory, projectOwners);
			owners.push(...projectOwners);
		}

		entry.cleanupEligible = projectOwners.length === 0;
		entry.reason = projectOwners.length === 0 ? null : 'active_owner';
	}

	return owners;
};

/**
 * Collects one read-only inventory of managed artifacts and Git state.
 *
 * Entries are disjoint, so category totals can be summed without nested
 * double-counting. `.git` and worktrees are reported separately.
 *
 * @param roots - Discovered audit roots.
 * @returns Normalized entries, owners, worktrees, and Git size.
 */
export const collectStorageAuditInventory = (roots: StorageAuditRootsType): StorageAuditInventoryType => {
	const entries = collectEntries(roots);
	const owners = refreshEligibility(entries);
	const publicEntries = entries.map((entry): StorageAuditEntryType => ({
		category: entry.category,
		path: normalizeAuditPath(entry.absolutePath, roots),
		bytes: entry.bytes,
		logicalBytes: entry.logicalBytes,
		rawKiB: Math.round(entry.bytes / 1024),
		files: entry.files,
		cleanupEligible: entry.cleanupEligible,
		reason: entry.reason,
	}));
	const gitDirectory = join(roots.repository, '.git');
	const gitFootprint = footprintOfDirectory(gitDirectory);
	const worktrees = worktreesOf(roots);

	return {
		entries: publicEntries,
		activeOwners: owners.map((owner) => ({
			pid: owner.pid,
			startedAt: owner.startedAt,
			path: normalizeAuditPath(owner.file, roots),
		})),
		worktrees,
		commit: gitOutput(roots.repository, ['rev-parse', 'HEAD']),
		gitDirectoryBytes: gitFootprint.bytes,
		gitDirectoryLogicalBytes: gitFootprint.logicalBytes,
	};
};
