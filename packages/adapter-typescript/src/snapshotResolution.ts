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

/**
 * Materialises one project's program through the recorder filesystem.
 *
 * Program construction is the authoritative resolution pass: the compiler
 * parses every reachable source file and probes every candidate path through
 * the recorder, so the captured manifest describes exactly what the facts
 * depend on. The program is retained on the snapshot so extraction queries one
 * program instead of rebuilding it. Walking files by hand would repeat the same
 * parse and resolution work as one synchronous API request per import.
 *
 * @param api - Compiler API bound to the recorder filesystem.
 * @param recorder - Capturing filesystem.
 * @param project - Parsed project configuration.
 * @returns The materialised program, owned by the caller.
 */
export const materializeProjectProgram = (api: ts.API, recorder: RecorderType, project: TypeScriptSnapshotProjectType): ts.Program => {
	const manifestCache = new Map<string, string | null>();
	const program = api.createProgram(
		project.parsed.fileNames,
		project.parsed.options,
		project.parsed.projectReferences === undefined ? undefined : {projectReferences: project.parsed.projectReferences},
	);

	try {
		for (const fileName of program.getSourceFileNames()) {
			recorder.addInput(fileName);
			addPackageManifest(recorder, fileName, manifestCache);
		}

		return program;
	} catch (error) {
		program[Symbol.dispose]();
		throw error;
	}
};
