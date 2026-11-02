import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {type ConfigType, toRepositoryPath} from '../../core/config/config.ts';
import {createCapturedSourceFileRecord, computeSourceHash} from '../../core/generation/sourceFiles.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {type ScanProjectResultType, type ScanResultType, type SourceFileType} from '../../core/model.ts';
import {isAuthoredSourceFile, TYPESCRIPT_IGNORED_SEGMENTS} from './sourcePaths.ts';
import {createTypeScriptInputSnapshot, snapshotWatchInputs, type TypeScriptSnapshotProjectType} from './inputSnapshot.ts';

export {collectConfigFiles, isAuthoredSourceFile, TYPESCRIPT_IGNORED_SEGMENTS} from './sourcePaths.ts';

export const TYPESCRIPT_EXTRACTOR_ID = 'typescript';
export const TYPESCRIPT_EXTRACTOR_VERSION = '0.3.0';

const debug = debugFor('scan');

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

const hashCompilerOptions = (options: ts.CompilerOptions): string => hash(JSON.stringify(options, Object.keys(options).sort()));

const majorOf = (version: string | null): string | null => (version === null ? null : (/^(?<major>\d+)/u.exec(version)?.groups?.['major'] ?? null));

const sortByPath = (left: SourceFileType, right: SourceFileType): number => left.path.localeCompare(right.path);

const projectConfigHash = (project: TypeScriptSnapshotProjectType): string =>
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
 * The adapter also captures every non-authored input that can change compiler
 * facts: declaration files, configuration chains, package manifests, lockfiles,
 * and module-resolution probes. Their identity is returned as `inputHash` and
 * published source records carry the exact captured bytes.
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
	const {snapshot, projects} = createTypeScriptInputSnapshot(config, knownPaths);
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
		const absolutePath = path.resolve(config.rootDir, knownPath);

		if (isAuthoredSourceFile(absolutePath, config.rootDir) && existsSync(absolutePath)) {
			candidates.add(absolutePath);
		}
	}

	const files = [...candidates]
		.map((fileName) => {
			const bytes = snapshot.readBytes(fileName);
			const text = snapshot.readFile(fileName);

			if (bytes === undefined || text === undefined) {
				// Preserve the native read failure (EISDIR, ENOENT, EACCES) so the
				// build cause stays classified as a source-read failure.
				readFileSync(fileName);
				throw new Error(`Source disappeared during scan: ${toRepositoryPath(config.rootDir, fileName)}`);
			}

			return createCapturedSourceFileRecord(fileName, config.rootDir, bytes, text);
		})
		.sort(sortByPath);
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
	const {inputHash} = snapshot.manifest;
	const watchInputs = snapshotWatchInputs(config.rootDir, snapshot.manifest);

	debug('scan complete', {
		files: files.length,
		candidates: candidates.size,
		excludedFileCount,
		projects: projectResults.map((project) => project.name),
		projectFileCount,
		configDiagnosticCount,
		sourceHash,
		configHash,
		inputHash,
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
		inputHash,
		watchInputs,
		projects: projectResults,
		projectFileCount,
		excludedFileCount,
		configDiagnosticCount,
		scanMs: Math.round(performance.now() - startedAt),
	};
};
