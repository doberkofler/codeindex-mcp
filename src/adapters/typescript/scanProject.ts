import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {z} from 'zod';
import {type ConfigType} from '../../core/config/config.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {type ScanResultType, type SourceFileType} from '../../core/model.ts';
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
 * @param config - Resolved project configuration.
 * @returns The declared version, or null when no package manifest declares one.
 */
const readDeclaredCompiler = (config: ConfigType): string | null => {
	const packageJsonPath = findPackageJson(dirname(config.projectFilePath), config.rootDir);

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

/**
 * Discovers, hashes, and fingerprints the configured TypeScript project.
 *
 * The scan reads source bytes but never executes or type-checks them. Its
 * output is deterministic for unchanged source and configuration, which lets the
 * publisher skip a rebuild safely.
 *
 * @param config - Resolved project configuration.
 * @param knownPaths - Files indexed by the current generation. They keep
 * imported files outside the project include, such as shared contracts, in the
 * freshness set.
 * @returns The scanned source manifest and fingerprints.
 * @throws {@link Error} When the project file cannot be read or contains fatal
 * configuration diagnostics.
 */
export const scanProject = (config: ConfigType, knownPaths: readonly string[] = []): ScanResultType => {
	const startedAt = performance.now();
	debug('scan start', {rootDir: config.rootDir, projectFile: config.projectFilePath, knownPaths: knownPaths.length});
	const projectFileBytes = readFileSync(config.projectFilePath, 'utf8');
	const configFile = ts.readConfigFile(config.projectFilePath, (fileName) => ts.sys.readFile(fileName));

	if (configFile.error !== undefined) {
		throw new Error(`Cannot read TypeScript configuration: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
	}

	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(config.projectFilePath), undefined, config.projectFilePath);
	const fatalErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

	if (fatalErrors.length > 0) {
		const messages = fatalErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ');
		throw new Error(`TypeScript configuration is invalid: ${messages}`);
	}

	let excludedFileCount = 0;
	const candidates = new Set(parsed.fileNames);

	for (const knownPath of knownPaths) {
		if (isAuthoredSourceFile(resolve(config.rootDir, knownPath), config.rootDir)) {
			candidates.add(resolve(config.rootDir, knownPath));
		}
	}

	const files: SourceFileType[] = [];

	for (const fileName of candidates) {
		if (!isAuthoredSourceFile(fileName, config.rootDir) || !existsSync(fileName)) {
			excludedFileCount += 1;
			continue;
		}

		files.push(createSourceFileRecord(fileName, config.rootDir));
	}

	files.sort(sortByPath);

	const sourceHash = computeSourceHash(files);
	const declaredCompilerVersion = readDeclaredCompiler(config);
	const compilerDrift = declaredCompilerVersion !== null && majorOf(declaredCompilerVersion) !== majorOf(ts.version);
	const configHash = hash(
		[
			`extractor:${TYPESCRIPT_EXTRACTOR_ID}@${TYPESCRIPT_EXTRACTOR_VERSION}`,
			`typescript:${ts.version}`,
			`declared-compiler:${declaredCompilerVersion ?? 'unknown'}`,
			`project-file:${hash(projectFileBytes)}`,
			`options:${hashCompilerOptions(parsed.options)}`,
			`exclusions:${TYPESCRIPT_IGNORED_SEGMENTS.join(',')}`,
		].join('\n'),
	);
	debug('scan complete', {
		files: files.length,
		candidates: candidates.size,
		excludedFileCount,
		projectFileCount: parsed.fileNames.length,
		configDiagnosticCount: parsed.errors.length,
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
		projectFileCount: parsed.fileNames.length,
		excludedFileCount,
		configDiagnosticCount: parsed.errors.length,
		scanMs: Math.round(performance.now() - startedAt),
	};
};
