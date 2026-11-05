import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, readdirSync, type Dirent} from 'node:fs';
import path from 'node:path';
import {type RetentionCategoryType, type RetentionDecisionType, type RetentionTargetType} from './retentionPolicy.ts';

const {basename, dirname, join, relative, resolve} = path;

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

const isWithin = (parent: string, child: string): boolean => {
	const relativePath = relative(resolve(parent), resolve(child));

	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
};

export const protectedTarget = (target: string, protectedPaths: readonly string[]): boolean =>
	protectedPaths.some((protectedPath) => isWithin(protectedPath, target));

const entriesOf = (directory: string): readonly Dirent[] => {
	try {
		return readdirSync(directory, {withFileTypes: true});
	} catch {
		return [];
	}
};

export const childDirectoriesOf = (directory: string): readonly string[] =>
	entriesOf(directory)
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => join(directory, entry.name));

export const childFilesOf = (directory: string): readonly string[] =>
	entriesOf(directory)
		.filter((entry) => entry.isFile() && !entry.isSymbolicLink())
		.map((entry) => join(directory, entry.name));

/**
 * Sums the logical bytes below one file or directory without following links.
 *
 * @param target - File or directory to measure.
 * @returns Total file bytes, or `0` when the target is unreadable.
 */
export const footprintBytes = (target: string): number => {
	let stats;

	try {
		stats = lstatSync(target);
	} catch {
		return 0;
	}

	if (stats.isSymbolicLink()) {
		return 0;
	}

	if (stats.isFile()) {
		return stats.size;
	}

	if (!stats.isDirectory()) {
		return 0;
	}

	return entriesOf(target).reduce((total, entry) => total + footprintBytes(join(target, entry.name)), 0);
};

export const mtimeOf = (target: string): number => {
	try {
		return lstatSync(target).mtimeMs;
	} catch {
		return 0;
	}
};

const sortedByAge = (paths: readonly string[]): readonly string[] => [...paths].sort((left, right) => mtimeOf(right) - mtimeOf(left));

export const gitOutput = (cwd: string, args: readonly string[]): string | null => {
	const result = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8', timeout: 10_000});

	return result.status === 0 ? result.stdout.trim() : null;
};

export const gitStateOf = (directory: string): 'clean' | 'dirty' | 'unknown' => {
	if (!existsSync(join(directory, '.git'))) {
		return 'unknown';
	}

	const status = gitOutput(directory, ['status', '--porcelain']);

	if (status === null) {
		return 'unknown';
	}

	return status.length === 0 ? 'clean' : 'dirty';
};

export const gitCommonRootOf = (directory: string): string | null => {
	const dotGit = join(directory, '.git');

	try {
		if (!lstatSync(dotGit).isFile()) {
			return null;
		}
	} catch {
		return null;
	}

	const commonDirectory = gitOutput(directory, ['rev-parse', '--git-common-dir']);

	if (commonDirectory === null || commonDirectory.length === 0) {
		return null;
	}

	const resolved = resolve(directory, commonDirectory);

	return basename(resolved) === '.git' ? dirname(resolved) : null;
};

/**
 * Removes stale Git worktree registrations whose working directories no longer exist.
 *
 * @param roots - Repositories whose worktree registrations may be stale.
 */
export const pruneWorktreeRegistrations = (roots: readonly string[]): void => {
	for (const root of new Set(roots.map((entry) => resolve(entry)))) {
		if (existsSync(root) && lstatSync(root).isDirectory()) {
			gitOutput(root, ['worktree', 'prune']);
		}
	}
};

export const ageBoundTargets = (
	input: Readonly<{
		category: RetentionCategoryType;
		paths: readonly string[];
		maxEntries: number;
		maxAgeMs: number;
		now: Date;
		protectedPaths: readonly string[];
	}>,
): Readonly<{targets: RetentionTargetType[]; refused: RetentionDecisionType[]; retained: RetentionDecisionType[]}> => {
	const targets: RetentionTargetType[] = [];
	const refused: RetentionDecisionType[] = [];
	const retained: RetentionDecisionType[] = [];

	for (const [index, target] of sortedByAge(input.paths).entries()) {
		const bytes = footprintBytes(target);

		if (protectedTarget(target, input.protectedPaths)) {
			refused.push({category: input.category, path: target, bytes, reason: 'protected_path'});
			continue;
		}

		const expired = input.now.getTime() - mtimeOf(target) > input.maxAgeMs;

		if (expired || index >= input.maxEntries) {
			targets.push({category: input.category, path: target, bytes});
		} else {
			retained.push({category: input.category, path: target, bytes, reason: 'within_bound'});
		}
	}

	return {targets, refused, retained};
};
