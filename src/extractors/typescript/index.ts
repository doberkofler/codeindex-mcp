import {type ConfigType} from '../../config/config.ts';
import {type ScanResultType, type SourceFileType} from '../../index/model.ts';
import {createSourceFileRecord} from '../../index/sourceFiles.ts';
import {type ExtractorBuildType, type ExtractorType} from '../types.ts';
import {extractDependencyFacts} from './extractDependencies.ts';
import {extractSymbolFacts} from './extractSymbols.ts';
import {loadTypeScriptProject, type LoadedProjectType} from './loadProject.ts';
import {
	collectConfigFiles,
	isAuthoredSourceFile,
	scanProject,
	TYPESCRIPT_EXTRACTOR_ID,
	TYPESCRIPT_EXTRACTOR_VERSION,
	TYPESCRIPT_IGNORED_SEGMENTS,
} from './scanProject.ts';

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const LIMITATIONS: readonly string[] = [
	'JavaScript indexing requires allowJs in the selected project file',
	'declaration files and generated output are resolution-only',
	'only files reachable from the selected project file are indexed',
	'other languages and cross-language edges are not indexed',
	'no fuzzy search, embeddings, or full-text search',
];

const mergeProjectFiles = (config: ConfigType, scan: ScanResultType, project: LoadedProjectType): readonly SourceFileType[] => {
	const mergedFiles = new Map(scan.files.map((file) => [file.path, file]));

	for (const sourceFile of project.program.getSourceFiles()) {
		if (!isAuthoredSourceFile(sourceFile.fileName, config.rootDir)) {
			continue;
		}

		const record = createSourceFileRecord(sourceFile.fileName, config.rootDir);

		if (!mergedFiles.has(record.path)) {
			mergedFiles.set(record.path, record);
		}
	}

	return [...mergedFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
};

const build = (config: ConfigType, scan: ScanResultType): ExtractorBuildType => {
	const compilerStartedAt = performance.now();
	const project = loadTypeScriptProject(config);
	const compilerMs = Math.round(performance.now() - compilerStartedAt);
	const files = mergeProjectFiles(config, scan, project);
	const extractionStartedAt = performance.now();
	const facts = extractSymbolFacts({project, files, projectId: config.projectId, rootDir: config.rootDir});
	const dependencies = extractDependencyFacts({project, files, projectId: config.projectId, rootDir: config.rootDir});
	const extractionMs = Math.round(performance.now() - extractionStartedAt);

	return {
		files,
		symbols: facts.symbols,
		occurrences: facts.occurrences,
		dependencies,
		diagnostics: [...project.diagnostics, ...facts.diagnostics],
		compilerMs,
		extractionMs,
	};
};

/**
 * TypeScript and JavaScript extractor backed by the TypeScript compiler API.
 *
 * The adapter owns every compiler object and emits only serializable facts.
 */
export const typeScriptExtractor: ExtractorType = {
	id: TYPESCRIPT_EXTRACTOR_ID,
	version: TYPESCRIPT_EXTRACTOR_VERSION,
	displayName: 'TypeScript / JavaScript',
	sourceExtensions: SOURCE_EXTENSIONS,
	ignoredSegments: TYPESCRIPT_IGNORED_SEGMENTS,
	limitations: LIMITATIONS,
	scan: scanProject,
	build,
	configFiles: (config) => collectConfigFiles(config.projectFilePath),
	isSourceFile: isAuthoredSourceFile,
};
