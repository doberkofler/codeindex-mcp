import path from 'node:path';

const {isAbsolute, relative, sep} = path;

/**
 * Converts an absolute path to a workspace-relative POSIX path.
 *
 * Persisted paths are workspace-relative and POSIX, so every adapter and every
 * storage key derives from the same spelling.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param absolutePath - Absolute path inside the workspace.
 * @returns Workspace-relative POSIX path.
 * @throws {Error} When the path is outside the indexed workspace.
 */
export const toRepositoryPath = (rootDir: string, absolutePath: string): string => {
	const relativePath = relative(rootDir, absolutePath);

	if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
		throw new Error(`Path is outside the indexed working copy: ${absolutePath}`);
	}

	return relativePath.split(sep).join('/');
};
