import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const {dirname, isAbsolute, join, relative, resolve, sep} = path;

/** Extensions the adapter publishes as authored source. */
export const PUBLISHABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Declaration-file suffixes that participate in resolution but are not published. */
const DECLARATION_SUFFIXES: readonly string[] = ['.d.ts', '.d.mts', '.d.cts'];

export const TYPESCRIPT_IGNORED_SEGMENTS: readonly string[] = [
	'node_modules',
	'dist',
	'build',
	'out',
	'temp',
	'coverage',
	'public',
	'__generated__',
	'generated',
	'deploy',
	'.vite',
];

/**
 * Reports whether an absolute path is inside one directory.
 *
 * @param rootDir - Absolute directory that bounds the workspace.
 * @param absolutePath - Candidate absolute path.
 * @returns True when the path is inside the root.
 */
export const isInsideRoot = (rootDir: string, absolutePath: string): boolean => {
	const relativePath = relative(rootDir, absolutePath);
	return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
};

/**
 * Reports whether a workspace-relative path contains an ignored segment.
 *
 * @param relativePath - Workspace-relative path.
 * @returns True when any segment is excluded.
 */
export const isExcludedSegment = (relativePath: string): boolean =>
	relativePath
		.split(sep)
		.map((segment) => segment.toLowerCase())
		.some((segment) => TYPESCRIPT_IGNORED_SEGMENTS.includes(segment));

/**
 * Reports whether an absolute path names a declaration file.
 *
 * @param absolutePath - Candidate absolute path.
 * @returns True for `.d.ts`, `.d.mts`, and `.d.cts` files.
 */
export const isDeclarationFile = (absolutePath: string): boolean => DECLARATION_SUFFIXES.some((suffix) => absolutePath.endsWith(suffix));

/**
 * Reports whether a compiler source file is authored, publishable source.
 *
 * Dependency declarations and generated files still participate in TypeScript
 * resolution; they are only excluded from published index facts.
 *
 * @param absolutePath - Candidate source file path.
 * @param rootDir - Absolute indexed workspace root.
 * @returns Whether the file is authored, publishable source.
 */
export const isAuthoredSourceFile = (absolutePath: string, rootDir: string): boolean => {
	if (!isInsideRoot(rootDir, absolutePath)) {
		return false;
	}

	if (isExcludedSegment(relative(rootDir, absolutePath))) {
		return false;
	}

	if (isDeclarationFile(absolutePath)) {
		return false;
	}

	return PUBLISHABLE_EXTENSIONS.some((extension) => absolutePath.endsWith(extension));
};

/**
 * Finds the nearest package manifest at or above one directory.
 *
 * @param startDirectory - Directory to inspect first.
 * @param rootDir - Absolute indexed workspace root; limits the walk.
 * @returns Absolute manifest path, or null.
 */
const findPackageJson = (startDirectory: string, rootDir: string): string | null => {
	let directory = startDirectory;

	for (;;) {
		const candidate = join(directory, 'package.json');

		if (existsSync(candidate)) {
			return candidate;
		}

		if (directory === rootDir || dirname(directory) === directory) {
			return null;
		}

		directory = dirname(directory);
	}
};

/**
 * Resolves the effective TypeScript configuration file chain.
 *
 * TypeScript reads the root file and every `extends` target itself, including
 * JSONC comments, trailing commas, and package manifests used for package
 * resolution. Recording the files it reads keeps the watch set identical to the
 * inputs that can change the effective configuration.
 *
 * @param projectFilePath - Absolute tsconfig or jsconfig path.
 * @param rootDir - Absolute indexed workspace root; limits package-manifest discovery.
 * @returns Every existing configuration and package manifest read for the project.
 */
export const collectConfigFiles = (projectFilePath: string, rootDir?: string): readonly string[] => {
	const rootFile = resolve(projectFilePath);
	const files = new Set<string>();
	const addFile = (fileName: string): void => {
		const resolved = resolve(fileName);

		if (existsSync(resolved)) {
			files.add(realpathSync(resolved));
		}
	};
	const host: ts.ParseConfigFileHost = {
		...ts.sys,
		readFile: (fileName): string | undefined => {
			addFile(fileName);
			return ts.sys.readFile(fileName);
		},
		onUnRecoverableConfigFileDiagnostic: (): void => {
			// The scanner reports configuration diagnostics; watching still works.
		},
	};

	try {
		ts.getParsedCommandLineOfConfigFile(rootFile, undefined, host);
	} catch {
		// Invalid configuration is reported by the scanner; watching the file still helps.
	}

	addFile(rootFile);

	const packageRoot = rootDir === undefined ? path.parse(rootFile).root : resolve(rootDir);
	const packageJson = findPackageJson(dirname(rootFile), packageRoot);

	if (packageJson !== null) {
		addFile(packageJson);
	}

	return [...files];
};
