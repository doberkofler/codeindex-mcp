import {createHash} from 'node:crypto';
import {existsSync, realpathSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {type AdapterConfigType} from './adapterConfig.ts';

const {isAbsolute, join, relative, resolve, sep} = path;

export const DEFAULT_EXTRACTOR_ID = 'typescript';
export const DEFAULT_PROJECT_FILE = 'tsconfig.json';

/**
 * Reports one bounded configuration failure.
 *
 * @param message - Failure detail without filesystem-independent secrets.
 * @returns Never; always throws.
 */
export const fail = (message: string): never => {
	throw new Error(`Invalid code index configuration: ${message}`);
};

export const isInside = (parent: string, candidate: string): boolean => {
	const relativePath = relative(parent, candidate);
	return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
};

export const resolveWithin = (rootDir: string, baseDirectory: string, candidate: string, label: string): string => {
	const resolved = resolve(baseDirectory, candidate);

	if (!isAbsolute(resolved)) {
		return fail(`${label} must resolve to an absolute path`);
	}

	if (!existsSync(resolved)) {
		return fail(`${label} does not exist: ${resolved}`);
	}

	const realRoot = realpathSync(rootDir);
	const realCandidate = realpathSync(resolved);

	if (isInside(realRoot, realCandidate)) {
		return realCandidate;
	}

	return fail(`${label} must stay inside the configured root: ${resolved}`);
};

export const assertFile = (filePath: string, label: string): void => {
	if (!existsSync(filePath)) {
		fail(`${label} does not exist: ${filePath}`);
	}

	if (!statSync(filePath).isFile()) {
		fail(`${label} is not a file: ${filePath}`);
	}
};

export const derivedProjectName = (rootDir: string, projectFilePath: string): string => {
	const relativePath = relative(rootDir, projectFilePath).split(sep).join('/');
	const separator = relativePath.lastIndexOf('/');

	return separator === -1 ? 'root' : relativePath.slice(0, separator);
};

/**
 * Creates a stable, non-reversible storage key for one index scope.
 *
 * A configuration file defines one scope, so adding or removing an adapter from
 * the same file revises the same database. Without a configuration file the
 * scope is the implicit singular adapter identity.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param configPath - Absolute configuration file, or null when none is used.
 * @param adapters - Configured adapters.
 * @returns A stable 16-character project identifier.
 */
export const createStorageKey = (rootDir: string, configPath: string | null, adapters: readonly AdapterConfigType[]): string => {
	if (configPath !== null) {
		return createHash('sha256')
			.update(`${rootDir}\nconfig\n${realpathSync(configPath)}`)
			.digest('hex')
			.slice(0, 16);
	}

	const adapterIdentity = adapters
		.map(
			(adapter) =>
				`${adapter.id}\n${adapter.projects
					.map((project) => project.projectFilePath)
					.sort()
					.join('\n')}`,
		)
		.sort()
		.join('\n');

	return createHash('sha256').update(`${rootDir}\nimplicit\n${adapterIdentity}`).digest('hex').slice(0, 16);
};

/**
 * Returns the root holding one index database per indexed project.
 *
 * @returns Absolute index root directory.
 */
export const indexRootDirectory = (): string => join(homedir(), '.local', 'share', 'codeindex-mcp');
