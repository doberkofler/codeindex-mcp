import path from 'node:path';
import type * as ts from './compiler.ts';
import {type RecorderType} from './snapshotRecorder.ts';
import {type TypeScriptSnapshotProjectType} from './snapshotTypes.ts';

const {dirname, join} = path;
const MAX_PACKAGE_WALK = 32;

const nearestPackageJson = (recorder: RecorderType, startDirectory: string, cache: Map<string, string | null>): string | null => {
	const cached = cache.get(startDirectory);

	if (cached !== undefined) {
		return cached;
	}

	let directory = startDirectory;
	let result: string | null = null;

	for (let depth = 0; depth < MAX_PACKAGE_WALK; depth += 1) {
		const candidate = join(directory, 'package.json');

		if (recorder.fileExists(candidate)) {
			result = candidate;
			break;
		}

		const parent = dirname(directory);

		if (parent === directory) {
			break;
		}

		directory = parent;
	}

	cache.set(startDirectory, result);
	return result;
};

const addPackageManifest = (recorder: RecorderType, absolutePath: string, cache: Map<string, string | null>): void => {
	const manifest = nearestPackageJson(recorder, dirname(absolutePath), cache);

	if (manifest !== null) {
		recorder.addInput(manifest);
	}
};

/** Programs materialised from one compiler snapshot, keyed by project file. */
type MaterializedProjectsType = Readonly<{
	readonly snapshot: ts.Snapshot;
	readonly programs: ReadonlyMap<string, ts.Program>;
}>;

/**
 * Materialises every configured project's program through the recorder
 * filesystem.
 *
 * The compiler opens the projects as configured projects, so each program
 * resolves compiler options against its own project directory instead of the
 * API process working directory. That distinction matters outside the
 * workspace root: a nested project's `types` entries resolve from the nested
 * project, exactly as the project's own type check does.
 *
 * Program construction is the authoritative resolution pass: the compiler
 * parses every reachable source file and probes every candidate path through
 * the recorder, so the captured manifest describes exactly what the facts
 * depend on. Walking files by hand would repeat the same parse and resolution
 * work as one synchronous API request per import.
 *
 * @param api - Compiler API bound to the recorder filesystem.
 * @param recorder - Capturing filesystem.
 * @param projects - Parsed project configurations.
 * @returns The compiler snapshot, its programs keyed by project file, and the
 * snapshot's ownership handle.
 */
export const materializeProjectPrograms = (
	api: ts.API,
	recorder: RecorderType,
	projects: readonly TypeScriptSnapshotProjectType[],
): MaterializedProjectsType => {
	const manifestCache = new Map<string, string | null>();
	const snapshot = api.createSnapshot({
		openProjects: projects.map((project) => project.projectFilePath),
		ensurePrograms: true,
	});

	try {
		const programs = new Map<string, ts.Program>();

		for (const project of projects) {
			const configured = snapshot.getConfiguredProject(project.projectFilePath);

			if (configured === undefined) {
				throw new Error(`TypeScript did not load configured project ${project.name}`);
			}

			programs.set(project.projectFilePath, configured.program);

			for (const fileName of configured.program.getSourceFileNames()) {
				recorder.addInput(fileName);
				addPackageManifest(recorder, fileName, manifestCache);
			}
		}

		return {snapshot, programs};
	} catch (error) {
		snapshot[Symbol.dispose]();
		throw error;
	}
};
