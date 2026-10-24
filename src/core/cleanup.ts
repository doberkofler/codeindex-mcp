import {existsSync, lstatSync, readdirSync, rmSync, type Dirent} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {Command} from 'commander';
import {type CommandIoType, configureCommand, parseCommand} from '../transports/cli/commanderSupport.ts';
import {activeProcessOwnersInDirectory} from './storage/processOwnership.ts';

const {basename, dirname, isAbsolute, join, relative, resolve} = path;

export type CleanupRootsType = Readonly<{
	storage: string;
	/** Current workspace database, or `null` when cleaning every managed project. */
	databasePath: string | null;
	protectedPaths: readonly string[];
}>;

export type CleanupOptionsType = Readonly<{
	yes: boolean;
	all: boolean;
}>;

/** Resolves cleanup roots; the `all` flag selects every managed database. */
export type CleanupRootsResolverType = (all: boolean) => CleanupRootsType;

export type CleanupTargetType = Readonly<{
	path: string;
	bytes: number;
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

const directorySize = (directory: string): number => {
	let total = 0;
	const pending = [directory];

	while (pending.length > 0) {
		const current = pending.pop();

		if (current === undefined) {
			continue;
		}

		let entries: readonly Dirent[];

		try {
			entries = readdirSync(current, {withFileTypes: true});
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(current, entry.name);

			if (entry.isSymbolicLink()) {
				continue;
			}

			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}

			try {
				total += lstatSync(entryPath).size;
			} catch {
				continue;
			}
		}
	}

	return total;
};

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

		return [{path: target, bytes: directorySize(target)}];
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
			return [{path: target, bytes: lstatSync(target).size}];
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

	return [{path: projectDirectory, bytes: directorySize(projectDirectory)}];
};

const assertNoActiveProcesses = (targets: readonly CleanupTargetType[]): void => {
	const directories = new Set(
		targets.map((target) => {
			try {
				return existsSync(target.path) && lstatSync(target.path).isDirectory() ? target.path : dirname(target.path);
			} catch {
				return dirname(target.path);
			}
		}),
	);
	const active = [...directories].flatMap((directory) => activeProcessOwnersInDirectory(directory));

	if (active.length > 0) {
		throw new Error(`Refusing to clean while code index processes are active:\n${active.map((owner) => `${owner.pid}: ${owner.file}`).join('\n')}`);
	}
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
export const collectCleanupTargets = (roots: CleanupRootsType, options: CleanupOptionsType): readonly CleanupTargetType[] => {
	assertSafeRoot(roots.storage, 'storage root', roots.protectedPaths);
	const targets = options.all ? childTargets(roots.storage, roots.protectedPaths) : currentTargets(roots);
	assertNoActiveProcesses(targets);

	return targets;
};

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

export const executeCleanup = (options: CleanupOptionsType, rootsOf: CleanupRootsResolverType, io: CommandIoType = processIo): void => {
	const targets = collectCleanupTargets(rootsOf(options.all), options);
	const total = targets.reduce((sum, target) => sum + target.bytes, 0);

	if (targets.length === 0) {
		io.stdout('Nothing to clean.');
		return;
	}

	for (const target of targets) {
		io.stdout(`${options.yes ? 'remove' : 'would remove'} ${target.path} (${formatSize(target.bytes)})`);
	}

	if (!options.yes) {
		io.stdout(`Dry run: ${formatSize(total)} in ${targets.length} target(s). Pass --yes to delete.`);
		return;
	}

	const removed = removeCleanupTargets(targets, io);
	io.stdout(`Removed ${targets.length} target(s), ${formatSize(removed)}.`);
};

const cleanupCommand = (rootsOf: CleanupRootsResolverType, io: CommandIoType): Command => {
	const command = configureCommand(
		new Command('clean')
			.description('Remove the current project index database. The repository and dist are never touched. The default is a dry run.')
			.option('--yes', 'delete the listed targets')
			.option('--all', 'remove every managed project database under the default index root')
			.allowExcessArguments(true),
		io,
	).action((options: Readonly<{yes?: boolean | undefined; all?: boolean | undefined}>) => {
		if (command.args.length > 0) {
			throw new Error(`Unexpected argument: ${command.args[0] ?? ''}\n\n${command.helpInformation().trimEnd()}`);
		}

		executeCleanup({yes: options.yes === true, all: options.all === true}, rootsOf, io);
	});

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
