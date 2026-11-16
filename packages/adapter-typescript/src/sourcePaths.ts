import {existsSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {parse as parseJsonc} from 'jsonc-parser';
import {z} from 'zod';

const ConfigChainSchema = z.looseObject({
	extends: z.union([z.string(), z.array(z.string())]).optional(),
});

const WatchConfigSchema = ConfigChainSchema.extend({
	files: z.array(z.string()).optional(),
	include: z.array(z.string()).optional(),
	exclude: z.array(z.string()).optional(),
});

const PackageTsconfigSchema = z.looseObject({
	tsconfig: z.string().optional(),
	main: z.string().optional(),
});

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

const readJsonObject = (fileName: string): unknown => {
	try {
		return parseJsonc(readFileSync(fileName, 'utf8'), [], {allowTrailingComma: true});
	} catch {
		return undefined;
	}
};

const existingRealPath = (fileName: string): string | null => {
	const resolved = resolve(fileName);
	return existsSync(resolved) ? realpathSync(resolved) : null;
};

const resolveConfigCandidate = (candidate: string): string | null =>
	[`${candidate}.json`, candidate, join(candidate, 'tsconfig.json')].find((fileName) => existsSync(fileName) && !fileName.endsWith(path.sep)) ?? null;

const resolvePackageExtends = (specifier: string, fromDirectory: string, addFile: (fileName: string) => string | null): string | null => {
	let directory = fromDirectory;

	for (;;) {
		const base = join(directory, 'node_modules', specifier);
		const direct = resolveConfigCandidate(base);
		const manifestPath = join(base, 'package.json');

		if (existsSync(manifestPath)) {
			addFile(manifestPath);
			const parsed = PackageTsconfigSchema.safeParse(readJsonObject(manifestPath));
			const configured = parsed.success ? (parsed.data.tsconfig ?? parsed.data.main) : undefined;

			if (configured !== undefined) {
				const target = resolveConfigCandidate(join(base, configured));

				if (target !== null) {
					return addFile(target);
				}
			}
		}

		if (direct !== null) {
			return addFile(direct);
		}

		const parent = dirname(directory);

		if (parent === directory) {
			return null;
		}

		directory = parent;
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
	const addFile = (fileName: string): string | null => {
		const resolved = resolve(fileName);

		if (!existsSync(resolved)) {
			return null;
		}

		const canonical = realpathSync(resolved);
		files.add(canonical);
		return canonical;
	};

	const visit = (fileName: string, visited: Set<string>): void => {
		const canonical = addFile(fileName);

		if (canonical === null || visited.has(canonical)) {
			return;
		}

		visited.add(canonical);
		const parsed = ConfigChainSchema.safeParse(readJsonObject(canonical));
		const extended = parsed.success ? parsed.data.extends : undefined;
		const specifiers = extended === undefined ? [] : typeof extended === 'string' ? [extended] : extended;

		for (const specifier of specifiers) {
			const resolved =
				specifier.startsWith('.') || isAbsolute(specifier)
					? resolveConfigCandidate(resolve(dirname(canonical), specifier))
					: resolvePackageExtends(specifier, dirname(canonical), addFile);

			if (resolved !== null) {
				visit(resolved, visited);
			}
		}
	};

	visit(rootFile, new Set());

	const packageRoot = rootDir === undefined ? path.parse(rootFile).root : resolve(rootDir);
	const packageJson = findPackageJson(dirname(rootFile), packageRoot);

	if (packageJson !== null) {
		addFile(packageJson);
	}

	return [...files];
};

type WatchListType = Readonly<{readonly baseDirectory: string; readonly values: readonly string[]}>;

/** Effective top-level file-selection fields with the config directory that owns each field. */
export type TypeScriptWatchSelectionType = Readonly<{
	readonly files?: WatchListType;
	readonly include?: WatchListType;
	readonly exclude?: WatchListType;
}>;

const selectedWatchList = (values: readonly string[] | undefined, inherited: WatchListType | undefined, baseDirectory: string): WatchListType | undefined =>
	values === undefined ? inherited : {baseDirectory, values};

const watchSelectionOf = (
	baseDirectory: string,
	value: z.infer<typeof WatchConfigSchema>,
	inherited: Readonly<{files: WatchListType | undefined; include: WatchListType | undefined; exclude: WatchListType | undefined}>,
): TypeScriptWatchSelectionType => {
	const files = selectedWatchList(value.files, inherited.files, baseDirectory);
	const include = selectedWatchList(value.include, inherited.include, baseDirectory);
	const exclude = selectedWatchList(value.exclude, inherited.exclude, baseDirectory);
	return {
		...(files === undefined ? {} : {files}),
		...(include === undefined ? {} : {include}),
		...(exclude === undefined ? {} : {exclude}),
	};
};

/**
 * Resolves inherited TypeScript file-selection fields for watch-plan creation.
 *
 * Later entries in an `extends` array and then the current file replace earlier
 * `files`, `include`, or `exclude` fields, matching TypeScript configuration
 * inheritance. Each field retains its declaring directory because patterns are
 * relative to that file rather than the leaf project.
 *
 * @param projectFilePath - Absolute tsconfig or jsconfig path.
 * @returns Effective file-selection fields.
 */
export const collectTypeScriptWatchSelection = (projectFilePath: string): TypeScriptWatchSelectionType => {
	const visit = (fileName: string, visiting: Set<string>): TypeScriptWatchSelectionType => {
		const canonical = existingRealPath(fileName);

		if (canonical === null || visiting.has(canonical)) {
			return {};
		}

		visiting.add(canonical);
		const parsed = WatchConfigSchema.safeParse(readJsonObject(canonical));
		const value = parsed.success ? parsed.data : {};
		const specifiers = value.extends === undefined ? [] : typeof value.extends === 'string' ? [value.extends] : value.extends;
		let files: WatchListType | undefined;
		let include: WatchListType | undefined;
		let exclude: WatchListType | undefined;

		for (const specifier of specifiers) {
			const extended =
				specifier.startsWith('.') || isAbsolute(specifier)
					? resolveConfigCandidate(resolve(dirname(canonical), specifier))
					: resolvePackageExtends(specifier, dirname(canonical), existingRealPath);

			if (extended !== null) {
				const inherited = visit(extended, visiting);
				files = inherited.files ?? files;
				include = inherited.include ?? include;
				exclude = inherited.exclude ?? exclude;
			}
		}

		visiting.delete(canonical);
		return watchSelectionOf(dirname(canonical), value, {files, include, exclude});
	};

	return visit(projectFilePath, new Set());
};
