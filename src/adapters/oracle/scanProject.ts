import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {type ConfigType, toRepositoryPath} from '../../core/config/config.ts';
import {createSourceFileRecord, computeSourceHash} from '../../core/generation/sourceFiles.ts';
import {type ScanProjectResultType, type ScanResultType, type SourceFileType} from '../../core/model.ts';
import {discoverOracleFiles, isOracleSourcePath, oracleManifestHash, readOracleManifest} from './manifest.ts';

export const ORACLE_EXTRACTOR_ID = 'oracle';
export const ORACLE_EXTRACTOR_VERSION = '0.1.0';
const ORACLE_GRAMMAR_REVISION = 'grammars-v4/e199816b3f1a7a49ea1ad84fb6b87c382ea36a33+plsqldoc/8c8a44b668833c5603f5e5c1761837fd56dbc4fd';
const ORACLE_RUNTIME_VERSION = 'antlr4ng@3.0.16';

const {isAbsolute, relative, sep} = path;

export const ORACLE_IGNORED_SEGMENTS: readonly string[] = ['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'coverage', 'temp', '.vite'];
const ORACLE_COMPILER_VERSION = `oracle19c;${ORACLE_RUNTIME_VERSION};grammar@${ORACLE_GRAMMAR_REVISION}`;

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const isInside = (rootDir: string, candidate: string): boolean => {
	const candidateRelative = relative(rootDir, candidate);
	return candidateRelative === '' || (!candidateRelative.startsWith(`..${sep}`) && candidateRelative !== '..' && !isAbsolute(candidateRelative));
};

/**
 * Reports whether an absolute path is publishable Oracle source in the workspace.
 *
 * Manifest include/exclude patterns remain authoritative for scanning.
 *
 * @param absolutePath - Candidate source path.
 * @param rootDir - Absolute indexed workspace root.
 * @returns Whether the path has a supported extension and stays inside the root.
 */
export const isOracleAuthoredSourceFile = (absolutePath: string, rootDir: string): boolean => {
	if (!isOracleSourcePath(absolutePath)) {
		return false;
	}

	if (
		relative(rootDir, absolutePath)
			.split(sep)
			.map((segment) => segment.toLowerCase())
			.some((segment) => ORACLE_IGNORED_SEGMENTS.includes(segment))
	) {
		return false;
	}

	try {
		return isInside(realpathSync(rootDir), realpathSync(absolutePath));
	} catch {
		return false;
	}
};

type ContextScanType = Readonly<{
	project: ScanProjectResultType;
	files: readonly SourceFileType[];
	excludedFileCount: number;
}>;

const scanContext = (config: ConfigType, context: ConfigType['projects'][number]): ContextScanType => {
	const manifest = readOracleManifest(context.projectFilePath);
	const discovery = discoverOracleFiles(config.rootDir, manifest.manifest);
	const files = discovery.files.map((file) => createSourceFileRecord(file.absolutePath, config.rootDir));
	const configHash = oracleManifestHash({
		manifestBytes: manifest.manifestBytes,
		canonicalSchema: manifest.canonicalSchema,
		include: manifest.manifest.include,
		exclude: manifest.manifest.exclude,
		extensions: manifest.manifest.extensions,
		grammarRevision: ORACLE_GRAMMAR_REVISION,
		runtimeVersion: ORACLE_RUNTIME_VERSION,
		files,
	});

	return {
		project: {
			name: context.name,
			projectFile: toRepositoryPath(config.rootDir, context.projectFilePath),
			configHash,
			projectFileCount: files.length,
			configDiagnosticCount: 0,
		},
		files,
		excludedFileCount: discovery.excludedFileCount,
	};
};

/**
 * Discovers deterministic Oracle source matches for every configured manifest.
 *
 * @param config - Resolved project configuration.
 * @param _knownPaths - Previously indexed paths; manifests remain authoritative.
 * @returns The scanned source manifest, per-context digests, and fingerprints.
 */
export const scanOracleProject = (config: ConfigType, _knownPaths: readonly string[] = []): ScanResultType => {
	const startedAt = performance.now();
	const contexts = config.projects.map((context) => scanContext(config, context));
	const merged = new Map<string, SourceFileType>();

	for (const context of contexts) {
		for (const file of context.files) {
			merged.set(file.path, file);
		}
	}

	const files = [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
	const projects = contexts.map((context) => context.project).sort((left, right) => left.name.localeCompare(right.name));
	const configHash = hash(
		[...projects.map((project) => `${project.name}:${project.configHash}`), `extractor:${ORACLE_EXTRACTOR_ID}@${ORACLE_EXTRACTOR_VERSION}`].join('\n'),
	);
	const projectFileCount = projects.reduce((total, project) => total + project.projectFileCount, 0);
	const excludedFileCount = contexts.reduce((total, context) => total + context.excludedFileCount, 0);
	const sourceHash = computeSourceHash(files);

	return {
		rootDir: config.rootDir,
		projectId: config.projectId,
		extractorId: ORACLE_EXTRACTOR_ID,
		extractorVersion: ORACLE_EXTRACTOR_VERSION,
		compilerVersion: ORACLE_COMPILER_VERSION,
		declaredCompilerVersion: null,
		compilerDrift: false,
		files,
		sourceHash,
		configHash,
		projects,
		projectFileCount,
		excludedFileCount,
		configDiagnosticCount: 0,
		scanMs: Math.round(performance.now() - startedAt),
	};
};

/**
 * Lists configuration files that affect the Oracle scan.
 *
 * @param config - Resolved project configuration.
 * @returns Absolute manifest paths in deterministic order.
 */
export const collectOracleConfigFiles = (config: ConfigType): readonly string[] =>
	[...new Set(config.projects.map((project) => realpathSync(project.projectFilePath)))].sort();
