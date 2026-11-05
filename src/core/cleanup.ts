import {existsSync, lstatSync, readdirSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {Command} from 'commander';
import {type CommandIoType, configureCommand, parseCommand} from '../transports/cli/commanderSupport.ts';
import {benchmarkCheckoutPlan, benchmarkResiduePlan} from './retentionBenchmark.ts';
import {oracleEvidencePlan} from './retentionEvidence.ts';
import {evaluationPlan} from './retentionEvaluation.ts';
import {RETENTION_POLICY, type RetentionCategoryType, type RetentionDecisionType, type RetentionPlanType, type RetentionReasonType} from './retentionPolicy.ts';
import {footprintBytes, pruneWorktreeRegistrations} from './retentionSupport.ts';
import {activeProcessOwnersInDirectory} from './storage/processOwnership.ts';

const {basename, dirname, isAbsolute, join, relative, resolve} = path;

export type CleanupRootsType = Readonly<{
	storage: string;
	/** Current workspace database, or `null` when cleaning every managed project. */
	databasePath: string | null;
	protectedPaths: readonly string[];
	/** Repository root used for benchmark residue and worktree registration cleanup. */
	repository?: string | undefined;
	/** Parent of process temporary benchmark workspaces and scratch databases. */
	temporaryDirectory?: string | undefined;
	/** Benchmark cache roots, including the prepared project checkout root. */
	cacheRoots?: readonly string[] | undefined;
	/** Roots that may contain Oracle evidence bundles. */
	evidenceRoots?: readonly string[] | undefined;
	/** Roots that may contain disposable evaluation state. */
	evaluationRoots?: readonly string[] | undefined;
	/** Committed Oracle descriptors whose bundles must be retained. */
	oracleBundleDescriptors?: readonly string[] | undefined;
	/** Deterministic clock for retention bounds. */
	now?: Date | undefined;
}>;

export type CleanupOptionsType = Readonly<{
	yes: boolean;
	all: boolean;
	/** Remove every prepared benchmark project checkout, not only stale ones. */
	benchmarkProjects?: boolean | undefined;
	/** Approve removal of dirty Git checkouts and worktrees. */
	discardDirty?: boolean | undefined;
}>;

/** Resolves cleanup roots; the `all` flag selects every managed database. */
export type CleanupRootsResolverType = (all: boolean) => CleanupRootsType;

type CleanupCategoryType = 'index_database' | RetentionCategoryType;

export type CleanupTargetType = Readonly<{
	path: string;
	bytes: number;
	category?: CleanupCategoryType | undefined;
}>;

type CleanupRefusalType = Readonly<{
	path: string;
	bytes: number;
	category: CleanupCategoryType;
	reason: RetentionReasonType;
}>;

type CleanupDeclinedType = Readonly<{
	category: 'repository_output';
	reason: string;
}>;

export type CleanupPlanType = Readonly<{
	targets: readonly CleanupTargetType[];
	refused: readonly CleanupRefusalType[];
	retained: readonly CleanupRefusalType[];
	declined: readonly CleanupDeclinedType[];
	worktreeRoots: readonly string[];
}>;

const INDEX_PATTERN = /^[0-9a-f]{16}$/u;
const DATABASE_NAME = 'index.sqlite';

const processIo: CommandIoType = {
	stdout: (line) => {
		process.stdout.write(`${line}\n`);
	},
	stderr: (line) => {
		process.stderr.write(`${line}\n`);
	},
};

const isWithin = (parent: string, child: string): boolean => {
	const relativePath = relative(resolve(parent), resolve(child));

	return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
};

const assertSafeRoot = (root: string, label: string, protectedPaths: readonly string[]): void => {
	if (!isAbsolute(root) || resolve(root) === path.parse(resolve(root)).root) {
		throw new Error(`Refusing to clean ${label}: unsafe root ${root}`);
	}

	if (resolve(root) === resolve(homedir())) {
		throw new Error(`Refusing to clean ${label}: root is the home directory`);
	}

	for (const protectedPath of protectedPaths) {
		if (isWithin(root, protectedPath)) {
			throw new Error(`Refusing to clean ${label}: ${protectedPath} is inside ${root}`);
		}
	}

	if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
		throw new Error(`Refusing to clean ${label}: root is a symbolic link`);
	}
};

const directorySize = footprintBytes;

const protectedTarget = (target: string, protectedPaths: readonly string[]): boolean => protectedPaths.some((protectedPath) => isWithin(target, protectedPath));

/**
 * Reports whether one child of the managed storage root holds a project database.
 *
 * Current directories are keyed by a 16-character storage key. Older releases
 * used an explicitly configured project id as the directory name, so a child
 * that still contains `index.sqlite` is also a project database. Anything else
 * in the tool-owned root is left alone.
 *
 * @param target - Absolute child directory.
 * @param name - Child directory name.
 * @returns Whether cleanup may remove the directory.
 */
const isManagedProjectDirectory = (target: string, name: string): boolean => INDEX_PATTERN.test(name) || existsSync(join(target, DATABASE_NAME));

const childTargets = (root: string, protectedPaths: readonly string[]): readonly CleanupTargetType[] => {
	if (!existsSync(root)) {
		return [];
	}

	return readdirSync(root, {withFileTypes: true}).flatMap((entry) => {
		const target = join(root, entry.name);

		if (!entry.isDirectory() || entry.isSymbolicLink() || !isManagedProjectDirectory(target, entry.name) || protectedTarget(target, protectedPaths)) {
			return [];
		}

		return [{path: target, bytes: directorySize(target), category: 'index_database' as const}];
	});
};

/**
 * Collects the SQLite files and sidecars of a database that is stored outside
 * the managed project layout.
 *
 * A configured `CODE_INDEX_DATABASE` may point at any directory, so cleanup
 * must not assume that the database's parent directory belongs to CodeIndex.
 *
 * @param databasePath - Resolved database file.
 * @param protectedPaths - Paths that must never be deleted.
 * @returns Existing files with their sizes.
 */
const databaseArtifacts = (databasePath: string, protectedPaths: readonly string[]): readonly CleanupTargetType[] => {
	const directory = dirname(databasePath);
	const name = basename(databasePath);

	if (!existsSync(directory)) {
		return [];
	}

	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const isArtifact =
			entry.name === name ||
			entry.name === `${name}-wal` ||
			entry.name === `${name}-shm` ||
			(entry.name.startsWith(`${name}.schema-`) && entry.name.endsWith('.bak')) ||
			(entry.name.startsWith(`${name}.owner-`) && entry.name.endsWith('.json'));
		const target = join(directory, entry.name);

		if (!entry.isFile() || entry.isSymbolicLink() || !isArtifact || protectedTarget(target, protectedPaths)) {
			return [];
		}

		try {
			return [{path: target, bytes: lstatSync(target).size, category: 'index_database' as const}];
		} catch {
			return [];
		}
	});
};

/**
 * Collects the database of the current workspace.
 *
 * A database in the managed `<storage>/<projectId>/index.sqlite` layout owns its
 * whole project directory. Any other path is an explicit override, so only the
 * database and its own sidecars are removed.
 *
 * @param roots - Storage root, current database, and protected paths.
 * @returns Existing target, if any.
 */
const currentTargets = (roots: CleanupRootsType): readonly CleanupTargetType[] => {
	if (roots.databasePath === null) {
		throw new Error('Refusing to clean the current project: no database path was resolved');
	}

	const databasePath = resolve(roots.databasePath);
	const projectDirectory = dirname(databasePath);
	const managed =
		basename(databasePath) === DATABASE_NAME && INDEX_PATTERN.test(basename(projectDirectory)) && resolve(dirname(projectDirectory)) === resolve(roots.storage);

	if (!managed) {
		return databaseArtifacts(databasePath, roots.protectedPaths);
	}

	if (!existsSync(projectDirectory) || lstatSync(projectDirectory).isSymbolicLink() || protectedTarget(projectDirectory, roots.protectedPaths)) {
		return [];
	}

	return [{path: projectDirectory, bytes: directorySize(projectDirectory), category: 'index_database'}];
};

const assertNoActiveProcesses = (targets: readonly CleanupTargetType[]): void => {
	// Owner markers live beside the database, so both the target itself and its
	// parent directory are checked. A file target denies directory listing and
	// therefore contributes no owners.
	const directories = new Set(targets.flatMap((target) => [target.path, dirname(target.path)]));
	const active = [...directories].flatMap((directory) => activeProcessOwnersInDirectory(directory));

	if (active.length > 0) {
		throw new Error(`Refusing to clean while code index processes are active:\n${active.map((owner) => `${owner.pid}: ${owner.file}`).join('\n')}`);
	}
};

const emptyRetentionPlan = (): RetentionPlanType => ({targets: [], refused: [], retained: [], worktreeRoots: []});

const retentionPlanOf = (roots: CleanupRootsType, options: CleanupOptionsType): RetentionPlanType => {
	const shared = {
		protectedPaths: roots.protectedPaths,
		now: roots.now,
		discardDirty: options.discardDirty,
	};
	const plans: RetentionPlanType[] = [];

	if (options.all) {
		plans.push(
			benchmarkResiduePlan({...shared, temporaryDirectory: roots.temporaryDirectory, repository: roots.repository}),
			oracleEvidencePlan({
				...shared,
				storageRoots: [roots.storage],
				evidenceRoots: roots.evidenceRoots ?? [],
				descriptorPaths: roots.oracleBundleDescriptors ?? [],
			}),
			evaluationPlan({...shared, evaluationRoots: roots.evaluationRoots ?? []}),
		);
	}

	if (options.all || (options.benchmarkProjects ?? false)) {
		plans.push(benchmarkCheckoutPlan({...shared, cacheRoots: roots.cacheRoots ?? [], removeAll: options.benchmarkProjects ?? false}));
	}

	return plans.length === 0
		? emptyRetentionPlan()
		: {
				targets: plans.flatMap((plan) => plan.targets),
				refused: plans.flatMap((plan) => plan.refused),
				retained: plans.flatMap((plan) => plan.retained),
				worktreeRoots: plans.flatMap((plan) => plan.worktreeRoots),
			};
};

const declinedOf = (roots: CleanupRootsType, options: CleanupOptionsType): readonly CleanupDeclinedType[] =>
	options.all && roots.repository !== undefined ? [{category: 'repository_output', reason: RETENTION_POLICY.repository_output.reason}] : [];

const dedupe = (targets: readonly CleanupTargetType[]): readonly CleanupTargetType[] => {
	const seen = new Set<string>();

	return targets.filter((target) => {
		const key = resolve(target.path);

		if (seen.has(key)) {
			return false;
		}

		seen.add(key);
		return true;
	});
};

const refusalOf = (decision: RetentionDecisionType): CleanupRefusalType => ({
	path: decision.path,
	bytes: decision.bytes,
	category: decision.category,
	reason: decision.reason,
});

/**
 * Collects every cleanup candidate, refusal, retained entry, and declined category.
 *
 * Index databases are always selected. Benchmark residue, prepared checkouts,
 * Oracle evidence, and evaluation state are selected by `--all`; prepared
 * checkouts can also be removed explicitly with `--benchmark-projects`.
 *
 * @param roots - Storage root, current database, protection, and retention roots.
 * @param options - Whether to target every managed database and retention category.
 * @returns The complete cleanup plan.
 * @throws {Error} When the root is unsafe, contains a protected path, or a live
 * process still owns a target database.
 */
export const collectCleanupPlan = (roots: CleanupRootsType, options: CleanupOptionsType): CleanupPlanType => {
	assertSafeRoot(roots.storage, 'storage root', roots.protectedPaths);
	const databaseTargets = options.all ? childTargets(roots.storage, roots.protectedPaths) : currentTargets(roots);
	assertNoActiveProcesses(databaseTargets);
	const retention = retentionPlanOf(roots, options);

	return {
		targets: dedupe([...databaseTargets, ...retention.targets]),
		refused: retention.refused.map(refusalOf),
		retained: retention.retained.map(refusalOf),
		declined: declinedOf(roots, options),
		worktreeRoots: retention.worktreeRoots,
	};
};

/**
 * Collects project index databases that are safe to delete.
 *
 * The default target is the database of the current workspace. Shared temporary
 * directories and other workspaces are never inspected, so cleanup cannot reach
 * caches that belong to another checkout on the same machine.
 *
 * @param roots - Storage root, current database, and paths that must never be deleted.
 * @param options - Whether to target every managed project database.
 * @returns Existing targets with their recursive sizes.
 * @throws {Error} When the root is unsafe, contains a protected path, or a live
 * process still owns a target database.
 */
export const collectCleanupTargets = (roots: CleanupRootsType, options: CleanupOptionsType): readonly CleanupTargetType[] =>
	collectCleanupPlan(roots, options).targets;

/**
 * Deletes collected targets.
 *
 * @param targets - Targets returned by {@link collectCleanupTargets}.
 * @param io - Output sinks; defaults to the process streams.
 * @returns Reclaimed bytes for targets removed successfully.
 */
export const removeCleanupTargets = (targets: readonly CleanupTargetType[], io: CommandIoType = processIo): number =>
	targets.reduce((total, target) => {
		try {
			rmSync(target.path, {recursive: true, force: true});
			return total + target.bytes;
		} catch (error) {
			io.stderr(`Failed to remove ${target.path}: ${error instanceof Error ? error.message : String(error)}`);
			return total;
		}
	}, 0);

/**
 * Formats a byte count with binary units for cleanup presentation.
 *
 * @param bytes - Byte count.
 * @returns Size with a binary unit suffix.
 */
export const formatSize = (bytes: number): string => {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}

	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
};

const printDecisions = (plan: CleanupPlanType, io: CommandIoType): void => {
	for (const retained of plan.retained) {
		io.stdout(`retain ${retained.path} (${retained.reason})`);
	}

	for (const refused of plan.refused) {
		io.stdout(`refuse ${refused.path} (${refused.reason})`);
	}

	for (const declined of plan.declined) {
		io.stdout(`decline ${declined.category} (${declined.reason})`);
	}
};

const pruneWorktrees = (roots: CleanupRootsType, plan: CleanupPlanType): void => {
	for (const root of [roots.repository, ...plan.worktreeRoots]) {
		if (root !== undefined) {
			pruneWorktreeRegistrations([root]);
		}
	}
};

export const executeCleanup = (options: CleanupOptionsType, rootsOf: CleanupRootsResolverType, io: CommandIoType = processIo): void => {
	const roots = rootsOf(options.all);
	const plan = collectCleanupPlan(roots, options);
	const total = plan.targets.reduce((sum, target) => sum + target.bytes, 0);

	if (plan.targets.length === 0) {
		if (options.yes) {
			pruneWorktrees(roots, plan);
		}

		printDecisions(plan, io);

		if (plan.retained.length === 0 && plan.refused.length === 0 && plan.declined.length === 0) {
			io.stdout('Nothing to clean.');
		} else {
			io.stdout('Nothing to remove.');
		}

		return;
	}

	for (const target of plan.targets) {
		io.stdout(`${options.yes ? 'remove' : 'would remove'} ${target.path} (${formatSize(target.bytes)})`);
	}

	printDecisions(plan, io);

	if (!options.yes) {
		io.stdout(`Dry run: ${formatSize(total)} in ${plan.targets.length} target(s). Pass --yes to delete.`);
		return;
	}

	const removed = removeCleanupTargets(plan.targets, io);
	pruneWorktrees(roots, plan);
	io.stdout(`Removed ${plan.targets.length} target(s), ${formatSize(removed)}.`);
};

const cleanupCommand = (rootsOf: CleanupRootsResolverType, io: CommandIoType): Command => {
	const command = configureCommand(
		new Command('clean')
			.description(
				'Remove the current project index database and, with --all, stale benchmark and evaluation residue. The repository and dist are never touched. The default is a dry run.',
			)
			.option('--yes', 'delete the listed targets')
			.option('--all', 'remove every managed project database and bounded benchmark, evidence, and evaluation residue')
			.option('--benchmark-projects', 'remove every prepared benchmark project checkout (retained while a suite needs them by default)')
			.option('--discard-dirty', 'approve removal of dirty Git checkouts and worktrees')
			.allowExcessArguments(true),
		io,
	).action(
		(
			options: Readonly<{yes?: boolean | undefined; all?: boolean | undefined; benchmarkProjects?: boolean | undefined; discardDirty?: boolean | undefined}>,
		) => {
			const [unexpected] = command.args;

			if (unexpected !== undefined) {
				throw new Error(`Unexpected argument: ${unexpected}\n\n${command.helpInformation().trimEnd()}`);
			}

			executeCleanup(
				{
					yes: options.yes === true,
					all: options.all === true,
					benchmarkProjects: options.benchmarkProjects === true,
					discardDirty: options.discardDirty === true,
				},
				rootsOf,
				io,
			);
		},
	);

	return command;
};

/**
 * Runs the `clean` subcommand.
 *
 * @param argv - Arguments after the `clean` command.
 * @param rootsOf - Resolves the storage root and either the current database
 * or every managed database. The CLI supplies the configured workspace.
 * @param io - Output sinks; defaults to the process streams.
 * @returns Process exit code.
 */
export const runCleanup = (argv: readonly string[], rootsOf: CleanupRootsResolverType, io: CommandIoType = processIo): number => {
	const program = new Command('codeindex-cli');
	program.addCommand(cleanupCommand(rootsOf, io));

	return parseCommand(program, ['clean', ...argv], io, {usageExitCode: 1});
};
