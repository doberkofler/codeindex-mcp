import {type AdapterConfigType, toRepositoryPath, createCapturedSourceFileRecord, type ScanResultType, type SourceFileType} from '@codeindex/adapter-sdk';
import {type LoadedProjectType} from './loadProject.ts';
import {isAuthoredSourceFile} from './sourcePaths.ts';

/**
 * Reads the exact bytes of one authored source file.
 *
 * Production builds read from the immutable input snapshot; qualification reads
 * the same current filesystem version the language service is querying.
 */
export type SourceBytesReaderType = (absolutePath: string) => Uint8Array | undefined;

/**
 * Merges one production program's authored files into the scanned manifest.
 *
 * Files imported from outside a project include are added with the bytes the
 * compiler parsed, so extraction, freshness, and verification observe the same
 * authored set. Multiple project contexts are merged by the caller.
 *
 * @param config - Resolved project configuration.
 * @param scan - Scan manifest for the workspace.
 * @param project - Loaded compiler program.
 * @param readBytes - Reader for the exact authored bytes.
 * @returns Authored files sorted by repository path.
 * @throws {Error} When an imported authored file disappeared before capture.
 */
export const mergeProjectFiles = (
	config: AdapterConfigType,
	scan: ScanResultType,
	project: LoadedProjectType,
	readBytes: SourceBytesReaderType,
): readonly SourceFileType[] => {
	const mergedFiles = new Map(scan.files.map((file) => [file.path, file]));

	for (const sourceFile of project.program.getSourceFiles()) {
		if (!isAuthoredSourceFile(sourceFile.fileName, config.rootDir)) {
			continue;
		}

		const path = toRepositoryPath(config.rootDir, sourceFile.fileName);

		if (!mergedFiles.has(path)) {
			const bytes = readBytes(sourceFile.fileName);

			if (bytes === undefined) {
				throw new Error(`Source disappeared during build: ${path}`);
			}

			mergedFiles.set(path, createCapturedSourceFileRecord(sourceFile.fileName, config.rootDir, bytes, sourceFile.text));
		}
	}

	return [...mergedFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
};
