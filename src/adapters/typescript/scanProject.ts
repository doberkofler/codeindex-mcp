import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {z} from 'zod';
import {type ConfigType, toRepositoryPath} from '../../core/config/config.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {type ScanProjectResultType, type ScanResultType, type SourceFileType} from '../../core/model.ts';
import {computeSourceHash, createSourceFileRecord} from '../../core/generation/sourceFiles.ts';

export const TYPESCRIPT_EXTRACTOR_ID = 'typescript';
export const TYPESCRIPT_EXTRACTOR_VERSION = '0.1.0';

const PUBLISHABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
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
	'deploy',
	'.vite',
];

const {dirname, isAbsolute, join, relative, resolve, sep} = path;
const debug = debugFor('scan');

const PackageJsonSchema = z.looseObject({
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
});

const compilerVersionOf = (specifier: string | undefined): string | null => {
	if (specifier === undefined) {
		return null;
	}

	const aliased = /typescript@(?<version>\d[^"\s]*)/u.exec(specifier);

	return aliased?.groups?.['version'] ?? specifier.replace(/^\D*/u, '');
};

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
 * Reads the compiler version the project declares.
 *
 * `typescript7` is an npm alias; when absent, the ordinary `typescript`
 * dependency is used. The extractor still requires the JavaScript compiler API,
 * so the declared version is only a drift signal.
 *
 * @param projectFilePath - Absolute project file.
 * @param rootDir - Absolute indexed workspace root.
 * @returns The declared version, or null when no package manifest declares one.
 */
const readDeclaredCompiler = (projectFilePath: string, rootDir: string): string | null => {
	const packageJsonPath = findPackageJson(dirname(projectFilePath), rootDir);

	if (packageJsonPath === null) {
		return null;
	}

	try {
		const parsed = PackageJsonSchema.safeParse(JSON.parse(readFileSync(packageJsonPath, 'utf8')));

		if (!parsed.success) {
			return null;
		}

		const {dependencies = {}, devDependencies = {}} = parsed.data;

		return (
			compilerVersionOf(devDependencies['typescript7'] ?? dependencies['typescript7']) ??
			compilerVersionOf(devDependencies['typescript'] ?? dependencies['typescript'])
		);
	} catch {
		return null;
	}
};

const majorOf = (version: string | null): string | null => (version === null ? null : (/^(?<major>\d+)/u.exec(version)?.groups?.['major'] ?? null));

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const isExcludedSegment = (relativePath: string): boolean =>
	relativePath
		.split(sep)
		.map((segment) => segment.toLowerCase())
		.some((segment) => TYPESCRIPT_IGNORED_SEGMENTS.includes(segment));

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
	const relativePath = relative(rootDir, absolutePath);

	if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
		return false;
	}

	if (isExcludedSegment(relativePath)) {
		return false;
	}

	if (DECLARATION_SUFFIXES.some((suffix) => absolutePath.endsWith(suffix))) {
		return false;
	}

	return PUBLISHABLE_EXTENSIONS.some((extension) => absolutePath.endsWith(extension));
};

const hashCompilerOptions = (options: ts.CompilerOptions): string => hash(JSON.stringify(options, Object.keys(options).sort()));

const sortByPath = (left: SourceFileType, right: SourceFileType): number => left.path.localeCompare(right.path);

const resolveExtends = (specifier: string, fromDirectory: string): string | null => {
	const candidate = isAbsolute(specifier) ? specifier : resolve(fromDirectory, specifier);

	for (const pathName of [candidate, `${candidate}.json`, join(candidate, 'tsconfig.json')]) {
		if (existsSync(pathName)) {
			return pathName;
		}
	}

	return null;
};

/**
 * Resolves the effective TypeScript configuration file chain.
 *
 * The chain is used only for watching; scanning still reads the root file
 * itself, which is authoritative for compiler options.
 *
 * @param projectFilePath - Absolute tsconfig or jsconfig path.
 * @param seen - Configuration files already visited.
 * @returns Every existing configuration file in the `extends` chain.
 */
export const collectConfigFiles = (projectFilePath: string, seen: Set<string> = new Set<string>()): readonly string[] => {
	if (seen.has(projectFilePath) || !existsSync(projectFilePath)) {
		return [...seen];
	}

	seen.add(projectFilePath);

	try {
		const parsed: unknown = JSON.parse(readFileSync(projectFilePath, 'utf8'));

		if (typeof parsed !== 'object' || parsed === null || !('extends' in parsed)) {
			return [...seen];
		}

		const {extends: extended} = parsed as {extends?: unknown};
		const specifiers = Array.isArray(extended) ? extended : [extended];

		for (const specifier of specifiers) {
			if (typeof specifier !== 'string') {
				continue;
			}

			const resolved = resolveExtends(specifier, dirname(projectFilePath));

			if (resolved !== null) {
				collectConfigFiles(resolved, seen);
			}
		}
	} catch {
		// Invalid JSON is reported by the scanner; watching the file still helps.
	}

	return [...seen];
};

type ParsedProjectType = Readonly<{
	readonly name: string;
	readonly projectFilePath: string;
	readonly projectFileBytes: string;
	readonly parsed: ts.ParsedCommandLine;
	readonly declaredCompilerVersion: string | null;
}>;

const parseProject = (rootDir: string, context: ConfigType['projects'][number]): ParsedProjectType => {
	const projectFileBytes = readFileSync(context.projectFilePath, 'utf8');
	const configFile = ts.readConfigFile(context.projectFilePath, (fileName) => ts.sys.readFile(fileName));

	if (configFile.error !== undefined) {
		throw new Error(`Cannot read TypeScript configuration ${context.projectFilePath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
	}

	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(context.projectFilePath), undefined, context.projectFilePath);
	const fatalErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

	if (fatalErrors.length > 0) {
		const messages = fatalErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ');
		throw new Error(`TypeScript configuration is invalid (${context.name}): ${messages}`);
	}

	return {
		name: context.name,
		projectFilePath: context.projectFilePath,
		projectFileBytes,
		parsed,
		declaredCompilerVersion: readDeclaredCompiler(context.projectFilePath, rootDir),
	};
};

const projectConfigHash = (project: ParsedProjectType): string =>
	hash(
		[
			`context:${project.name}`,
			`extractor:${TYPESCRIPT_EXTRACTOR_ID}@${TYPESCRIPT_EXTRACTOR_VERSION}`,
			`typescript:${ts.version}`,
			`declared-compiler:${project.declaredCompilerVersion ?? 'unknown'}`,
			`project-file:${hash(project.projectFileBytes)}`,
			`options:${hashCompilerOptions(project.parsed.options)}`,
			`exclusions:${TYPESCRIPT_IGNORED_SEGMENTS.join(',')}`,
		].join('\n'),
	);

/**
 * Discovers, hashes, and fingerprints every configured TypeScript project.
 *
 * Each project keeps its own parsed options and configuration digest. Source
 * files are the union of all project file sets plus previously indexed imports,
 * so shared declarations appear once while retaining one context per program.
 *
 * @param config - Resolved project configuration.
 * @param knownPaths - Files indexed by the current generation. They keep
 * imported files outside the project include in the freshness set.
 * @returns The scanned source manifest, per-project digests, and fingerprints.
 * @throws {@link Error} When a project file cannot be read or contains fatal
 * configuration diagnostics.
 */
export const scanProject = (config: ConfigType, knownPaths: readonly string[] = []): ScanResultType => {
	const startedAt = performance.now();
	debug('scan start', {rootDir: config.rootDir, projects: config.projects.map((project) => project.projectFilePath), knownPaths: knownPaths.length});
	const projects = config.projects.map((project) => parseProject(config.rootDir, project));
	let excludedFileCount = 0;
	const candidates = new Set<string>();

	for (const project of projects) {
		for (const fileName of project.parsed.fileNames) {
			if (isAuthoredSourceFile(fileName, config.rootDir) && existsSync(fileName)) {
				candidates.add(fileName);
			} else {
				excludedFileCount += 1;
			}
		}
	}

	for (const knownPath of knownPaths) {
		const absolutePath = resolve(config.rootDir, knownPath);

		if (isAuthoredSourceFile(absolutePath, config.rootDir) && existsSync(absolutePath)) {
			candidates.add(absolutePath);
		}
	}

	const files = [...candidates].map((fileName) => createSourceFileRecord(fileName, config.rootDir)).sort(sortByPath);
	const sourceHash = computeSourceHash(files);
	const declaredCompilerVersion = projects.find((project) => project.declaredCompilerVersion !== null)?.declaredCompilerVersion ?? null;
	const compilerDrift = projects.some(
		(project) => project.declaredCompilerVersion !== null && majorOf(project.declaredCompilerVersion) !== majorOf(ts.version),
	);
	const projectResults: readonly ScanProjectResultType[] = projects.map((project) => ({
		name: project.name,
		projectFile: toRepositoryPath(config.rootDir, project.projectFilePath),
		configHash: projectConfigHash(project),
		projectFileCount: project.parsed.fileNames.length,
		configDiagnosticCount: project.parsed.errors.length,
	}));
	const configHash = hash(
		[
			...[...projectResults].sort((left, right) => left.name.localeCompare(right.name)).map((project) => `${project.name}:${project.configHash}`),
			`exclusions:${TYPESCRIPT_IGNORED_SEGMENTS.join(',')}`,
		].join('\n'),
	);
	const projectFileCount = projectResults.reduce((total, project) => total + project.projectFileCount, 0);
	const configDiagnosticCount = projectResults.reduce((total, project) => total + project.configDiagnosticCount, 0);

	debug('scan complete', {
		files: files.length,
		candidates: candidates.size,
		excludedFileCount,
		projects: projectResults.map((project) => project.name),
		projectFileCount,
		configDiagnosticCount,
		sourceHash,
		configHash,
		declaredCompilerVersion,
		compilerDrift,
		durationMs: Math.round(performance.now() - startedAt),
	});

	return {
		rootDir: config.rootDir,
		projectId: config.projectId,
		extractorId: TYPESCRIPT_EXTRACTOR_ID,
		extractorVersion: TYPESCRIPT_EXTRACTOR_VERSION,
		compilerVersion: ts.version,
		declaredCompilerVersion,
		compilerDrift,
		files,
		sourceHash,
		configHash,
		projects: projectResults,
		projectFileCount,
		excludedFileCount,
		configDiagnosticCount,
		scanMs: Math.round(performance.now() - startedAt),
	};
};
