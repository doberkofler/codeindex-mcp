import {createHash} from 'node:crypto';
import {type Dirent, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import * as ts from './compiler.ts';
import {type AdapterConfigType, type ProjectContextConfigType} from '@codeindex/adapter-sdk';
import {isAuthoredSourceFile, isDeclarationFile, isExcludedSegment, isInsideRoot, TYPESCRIPT_IGNORED_SEGMENTS} from './sourcePaths.ts';
import {
	canonicalPath,
	keyOf,
	LOCKFILE_NAMES,
	WORKSPACE_INPUT_NAMES,
	type RecorderType,
	type SnapshotInputType,
	type SnapshotProbeType,
} from './snapshotRecorder.ts';
import {type TypeScriptInputManifestType, type TypeScriptSnapshotProjectType} from './snapshotTypes.ts';
import {recordProgramInputs} from './snapshotResolution.ts';

const {dirname, join, relative, resolve} = path;
const MAX_WORKSPACE_MANIFESTS = 5000;
const MAX_PACKAGE_WALK = 32;

export const hashOf = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

const PackageJsonSchema = z.looseObject({
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
});

const compilerVersionOf = (text: string): string | null => {
	try {
		const parsed = PackageJsonSchema.safeParse(JSON.parse(text));

		if (!parsed.success) {
			return null;
		}

		const {dependencies = {}, devDependencies = {}} = parsed.data;
		const specifier = devDependencies['typescript7'] ?? dependencies['typescript7'] ?? devDependencies['typescript'] ?? dependencies['typescript'];

		return specifier === undefined ? null : (/typescript@(?<version>\d[^"\s]*)/u.exec(specifier)?.groups?.['version'] ?? specifier.replace(/^\D*/u, ''));
	} catch {
		return null;
	}
};

const readDeclaredCompiler = (recorder: RecorderType, projectFilePath: string, rootDir: string): string | null => {
	let directory = dirname(projectFilePath);

	for (let depth = 0; depth < MAX_PACKAGE_WALK; depth += 1) {
		const text = recorder.readFile(join(directory, 'package.json'));

		if (text !== undefined) {
			return compilerVersionOf(text);
		}

		if (directory === rootDir || dirname(directory) === directory) {
			return null;
		}

		directory = dirname(directory);
	}

	return null;
};

export const parseProject = (api: ts.API, recorder: RecorderType, rootDir: string, context: ProjectContextConfigType): TypeScriptSnapshotProjectType => {
	const projectFileBytes = recorder.readFile(context.projectFilePath);

	if (projectFileBytes === undefined) {
		throw new Error(`TypeScript configuration does not exist: ${context.name}`);
	}

	const configFile = api.readConfigFile(context.projectFilePath);

	if (configFile.error !== undefined) {
		throw new Error(`Cannot read TypeScript configuration ${context.name}: ${ts.diagnosticText(configFile.error)}`);
	}

	const parsed = api.parseJsonConfigFileContent(configFile.config, {configFileName: context.projectFilePath});
	const fatalErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.ERROR_DIAGNOSTIC_CATEGORY);

	if (fatalErrors.length > 0) {
		const messages = fatalErrors.map((diagnostic) => ts.diagnosticText(diagnostic)).join('; ');
		throw new Error(`TypeScript configuration is invalid (${context.name}): ${messages}`);
	}

	const project: TypeScriptSnapshotProjectType = {
		name: context.name,
		projectFilePath: context.projectFilePath,
		projectFileBytes,
		parsed,
		declaredCompilerVersion: readDeclaredCompiler(recorder, context.projectFilePath, rootDir),
	};

	recorder.snapshot.projectByPath.set(context.projectFilePath, project);
	return project;
};

export const collectWorkspaceManifests = (recorder: RecorderType, rootDir: string): void => {
	let visited = 0;
	const walk = (directory: string): void => {
		if (visited >= MAX_WORKSPACE_MANIFESTS) {
			return;
		}

		let entries: readonly Dirent[];

		try {
			entries = readdirSync(directory, {withFileTypes: true});
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				const name = entry.name.toLowerCase();

				if (!name.startsWith('.') && !TYPESCRIPT_IGNORED_SEGMENTS.includes(name)) {
					walk(join(directory, entry.name));
				}
			} else if (entry.isFile() && entry.name === 'package.json') {
				visited += 1;
				recorder.addInput(join(directory, entry.name));
			}
		}
	};

	walk(rootDir);
};

export const rootMetadataOf = (recorder: RecorderType, rootDir: string): ReadonlyMap<string, string | null> => {
	const metadata = new Map<string, string | null>();

	for (const name of [...LOCKFILE_NAMES, ...WORKSPACE_INPUT_NAMES, 'package.json']) {
		const absolutePath = join(rootDir, name);
		const canonical = canonicalPath(absolutePath);
		recorder.fileExists(absolutePath);
		recorder.addInput(absolutePath);
		metadata.set(canonical, recorder.snapshot.inputs.get(canonical)?.sha256 ?? null);
	}

	return metadata;
};

const hashableInput = (input: SnapshotInputType): string | null =>
	input.kind === 'authored' || input.kind === 'compiler-lib' ? null : `${input.kind}\u0000${input.key}\u0000${input.sha256}`;

const computedInputHash = (inputs: readonly SnapshotInputType[], probes: readonly SnapshotProbeType[]): string => {
	const inputValues = inputs
		.map((input) => hashableInput(input))
		.filter((value): value is string => value !== null)
		.sort();
	const probeValues = probes.map((probe) => `${probe.kind}\u0000${probe.key}\u0000${probe.value}`).sort();

	return createHash('sha256')
		.update([...inputValues, ...probeValues].join('\n'))
		.digest('hex');
};

export const publicManifest = (recorder: RecorderType): TypeScriptInputManifestType => {
	const inputs = [...recorder.snapshot.inputs.values()].sort((left, right) => left.key.localeCompare(right.key));
	const probes = [...recorder.snapshot.probes.values()]
		.map((probe) => ({key: probe.key, kind: probe.kind, value: probe.value}))
		.sort((left, right) => left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind));

	return {inputs, probes, inputHash: computedInputHash(inputs, probes)};
};

const driftMessageOf = (rootDir: string, absolutePath: string): string => {
	const key = keyOf(rootDir, absolutePath);
	return key.startsWith('workspace:')
		? `TypeScript input changed during build: ${key.slice('workspace:'.length)}`
		: 'TypeScript external input changed during build';
};

export const validateSnapshot = (recorder: RecorderType): void => {
	for (const input of recorder.snapshot.inputs.values()) {
		let bytes: Buffer;

		try {
			bytes = readFileSync(input.absolutePath);
		} catch {
			throw new Error(driftMessageOf(recorder.snapshot.rootDir, input.absolutePath));
		}

		if (hashOf(bytes) !== input.sha256) {
			throw new Error(driftMessageOf(recorder.snapshot.rootDir, input.absolutePath));
		}
	}

	for (const probe of recorder.snapshot.probes.values()) {
		if (probe.recompute() !== probe.value) {
			throw new Error(driftMessageOf(recorder.snapshot.rootDir, probe.absolutePath));
		}
	}
};

export const watchInputsOf = (rootDir: string, manifest: TypeScriptInputManifestType): readonly string[] =>
	manifest.inputs
		.filter(
			(input) =>
				input.kind !== 'authored' &&
				input.kind !== 'compiler-lib' &&
				isInsideRoot(rootDir, input.absolutePath) &&
				!isExcludedSegment(relative(rootDir, input.absolutePath)),
		)
		.map((input) => input.absolutePath)
		.sort();

export const authoredCandidates = (
	config: AdapterConfigType,
	projects: readonly TypeScriptSnapshotProjectType[],
	knownPaths: readonly string[],
): readonly string[] => {
	const authored = new Set<string>();

	for (const project of projects) {
		for (const fileName of project.parsed.fileNames) {
			if (statSync(fileName, {throwIfNoEntry: false})?.isFile() === true && (isAuthoredSourceFile(fileName, config.rootDir) || isDeclarationFile(fileName))) {
				authored.add(canonicalPath(fileName));
			}
		}
	}

	for (const knownPath of knownPaths) {
		const absolutePath = resolve(config.rootDir, knownPath);

		if (statSync(absolutePath, {throwIfNoEntry: false})?.isFile() === true && isAuthoredSourceFile(absolutePath, config.rootDir)) {
			authored.add(canonicalPath(absolutePath));
		}
	}

	return [...authored].sort();
};

export const projectFileHashesOf = (projects: readonly TypeScriptSnapshotProjectType[]): ReadonlyMap<string, string> =>
	new Map(projects.map((project) => [project.projectFilePath, hashOf(project.projectFileBytes)]));

export const fileNamesOf = (projects: readonly TypeScriptSnapshotProjectType[]): readonly string[] =>
	projects.flatMap((project) => project.parsed.fileNames).sort();

export const sameMap = (left: ReadonlyMap<string, string | null>, right: ReadonlyMap<string, string | null>): boolean => {
	if (left.size !== right.size) {
		return false;
	}

	for (const [key, value] of left) {
		if (right.get(key) !== value) {
			return false;
		}
	}

	return true;
};

export const sameArray = (left: readonly string[], right: readonly string[]): boolean =>
	left.length === right.length && left.every((value, index) => value === right[index]);

export const programsOf = (snapshot: ts.Snapshot, projects: readonly TypeScriptSnapshotProjectType[]): ReadonlyMap<string, ts.Program> => {
	const programs = new Map<string, ts.Program>();

	for (const project of projects) {
		const configured = snapshot.getConfiguredProject(project.projectFilePath);

		if (configured === undefined) {
			throw new Error(`TypeScript did not load configured project ${project.name}`);
		}

		programs.set(project.projectFilePath, configured.program);
	}

	return programs;
};

export const addCurrentInputs = (
	input: Readonly<{
		recorder: RecorderType;
		config: AdapterConfigType;
		projects: readonly TypeScriptSnapshotProjectType[];
		programs: ReadonlyMap<string, ts.Program>;
		knownPaths: readonly string[];
	}>,
): ReadonlySet<string> => {
	const authoredPaths = new Set(authoredCandidates(input.config, input.projects, input.knownPaths));

	for (const absolutePath of authoredPaths) {
		input.recorder.addInput(absolutePath);
	}

	recordProgramInputs(input.recorder, input.programs.values());
	return authoredPaths;
};
