import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, readdirSync, rmSync, type Dirent} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {indexRootDirectory} from './config/config.ts';

const {isAbsolute, join, relative, resolve} = path;

export type CleanupRootsType = Readonly<{
	opencode: string;
	index: string;
	protectedPaths: readonly string[];
}>;

export type CleanupOptionsType = Readonly<{
	yes: boolean;
	keepIndex: boolean;
}>;

export type CleanupTargetType = Readonly<{
	path: string;
	bytes: number;
}>;

const OPENCODE_PATTERN = /^codeindex-/u;
const INDEX_PATTERN = /^[0-9a-f]{16}$/u;

const usage = `Usage: codeindex-cli clean [options]

Removes local code index caches. The repository and dist are never touched.
The default is a dry run.

Options:
  --yes                Delete the listed targets
  --keep-index         Keep project index databases
  --help               Print this message
`;

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

const childTargets = (root: string, pattern: RegExp, protectedPaths: readonly string[]): readonly CleanupTargetType[] => {
	if (!existsSync(root)) {
		return [];
	}

	return readdirSync(root, {withFileTypes: true}).flatMap((entry) => {
		const target = join(root, entry.name);

		if (!entry.isDirectory() || entry.isSymbolicLink() || !pattern.test(entry.name)) {
			return [];
		}

		for (const protectedPath of protectedPaths) {
			if (isWithin(target, protectedPath)) {
				return [];
			}
		}

		return [{path: target, bytes: directorySize(target)}];
	});
};

/**
 * Collects code index cache directories that are safe to delete.
 *
 * @param roots - Cache roots and paths that must never be deleted.
 * @param options - Whether to keep index databases.
 * @returns Existing targets with their recursive sizes.
 * @throws {Error} When a root is unsafe or contains a protected path.
 */
export const collectCleanupTargets = (roots: CleanupRootsType, options: CleanupOptionsType): readonly CleanupTargetType[] => {
	assertSafeRoot(roots.opencode, 'opencode root', roots.protectedPaths);
	assertSafeRoot(roots.index, 'index root', roots.protectedPaths);

	return [
		...childTargets(roots.opencode, OPENCODE_PATTERN, roots.protectedPaths),
		...(options.keepIndex ? [] : childTargets(roots.index, INDEX_PATTERN, roots.protectedPaths)),
	];
};

/**
 * Deletes collected targets.
 *
 * @param targets - Targets returned by {@link collectCleanupTargets}.
 * @returns Reclaimed bytes for targets removed successfully.
 */
export const removeCleanupTargets = (targets: readonly CleanupTargetType[]): number =>
	targets.reduce((total, target) => {
		try {
			rmSync(target.path, {recursive: true, force: true});
			return total + target.bytes;
		} catch (error) {
			process.stderr.write(`Failed to remove ${target.path}: ${error instanceof Error ? error.message : String(error)}\n`);
			return total;
		}
	}, 0);

const runningProcesses = (): readonly string[] => {
	const result = spawnSync('ps', ['-ax', '-o', 'pid=,command='], {encoding: 'utf8'});

	if (typeof result.stdout !== 'string') {
		return [];
	}

	return result.stdout.split('\n').flatMap((line) => {
		const trimmed = line.trimStart();
		const separator = trimmed.indexOf(' ');
		const pid = trimmed.slice(0, separator);
		const command = trimmed.slice(separator + 1);

		if (separator <= 0 || !/^\d+$/u.test(pid) || Number(pid) === process.pid) {
			return [];
		}

		const isMcp = /(?:^|\/)mcp\.mjs\s*$/u.test(command);
		const isConsole = /(?:^|\/)console\.mjs(?:\s|$)/u.test(command);

		return isMcp || isConsole ? [`${pid}: ${command.trim()}`] : [];
	});
};

const formatSize = (bytes: number): string => {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}

	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
};

const defaultRoots = (): CleanupRootsType => ({
	opencode: join(tmpdir(), 'opencode'),
	index: indexRootDirectory(),
	protectedPaths: [process.cwd()],
});

/**
 * Runs the `clean` subcommand.
 *
 * @param argv - Arguments after the `clean` command.
 * @returns Process exit code.
 */
export const runCleanup = (argv: readonly string[]): number => {
	try {
		const parsed = parseArgs({
			args: [...argv],
			options: {
				yes: {type: 'boolean', default: false},
				'keep-index': {type: 'boolean', default: false},
				help: {type: 'boolean', default: false},
			},
			allowPositionals: true,
		});

		if (parsed.values.help) {
			process.stdout.write(usage);
			return 0;
		}

		if (parsed.positionals.length > 0) {
			throw new Error(`Unexpected argument: ${parsed.positionals[0] ?? ''}\n\n${usage}`);
		}

		const running = runningProcesses();

		if (running.length > 0) {
			throw new Error(`Refusing to clean while code index processes are running:\n${running.join('\n')}`);
		}

		const options: CleanupOptionsType = {
			yes: parsed.values.yes,
			keepIndex: parsed.values['keep-index'],
		};
		const targets = collectCleanupTargets(defaultRoots(), options);
		const total = targets.reduce((sum, target) => sum + target.bytes, 0);

		if (targets.length === 0) {
			process.stdout.write('Nothing to clean.\n');
			return 0;
		}

		for (const target of targets) {
			process.stdout.write(`${options.yes ? 'remove' : 'would remove'} ${target.path} (${formatSize(target.bytes)})\n`);
		}

		if (!options.yes) {
			process.stdout.write(`Dry run: ${formatSize(total)} in ${targets.length} target(s). Pass --yes to delete.\n`);
			return 0;
		}

		const removed = removeCleanupTargets(targets);
		process.stdout.write(`Removed ${targets.length} target(s), ${formatSize(removed)}.\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
};
