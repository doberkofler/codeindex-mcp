import {createHash} from 'node:crypto';
import {type Dirent, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {z} from 'zod';
import {type AdapterConfigType, type ProjectContextConfigType} from '@codeindex/adapter-sdk';
import {debugFor} from '../../core/logging/debug.ts';
import {isAuthoredSourceFile, isDeclarationFile, isExcludedSegment, isInsideRoot, TYPESCRIPT_IGNORED_SEGMENTS} from './sourcePaths.ts';
import {
	canonicalPath,
	createRecorder,
	keyOf,
	LOCKFILE_NAMES,
	WORKSPACE_INPUT_NAMES,
	type RecorderType,
	type SnapshotInputType,
	type SnapshotProbeType,
} from './snapshotRecorder.ts';
import {collectReachableInputs} from './snapshotResolution.ts';
import {
	type CreatedTypeScriptInputSnapshotType,
	type TypeScriptInputManifestType,
	type TypeScriptInputSnapshotType,
	type TypeScriptSnapshotProjectType,
} from './snapshotTypes.ts';

export type {
	CreatedTypeScriptInputSnapshotType,
	TypeScriptInputManifestType,
	TypeScriptInputSnapshotType,
	TypeScriptSnapshotProjectType,
} from './snapshotTypes.ts';

const {dirname, join, relative, resolve} = path;
const debug = debugFor('snapshot');
const MAX_WORKSPACE_MANIFESTS = 5000;
const MAX_PACKAGE_WALK = 32;

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

const parseProject = (recorder: RecorderType, rootDir: string, context: ProjectContextConfigType): TypeScriptSnapshotProjectType => {
	const projectFileBytes = recorder.readFile(context.projectFilePath);

	if (projectFileBytes === undefined) {
		throw new Error(`TypeScript configuration does not exist: ${context.name}`);
	}

	const configFile = ts.readConfigFile(context.projectFilePath, (fileName) => recorder.readFile(fileName));

	if (configFile.error !== undefined) {
		throw new Error(`Cannot read TypeScript configuration ${context.name}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
	}

	const parseHost: ts.ParseConfigHost = {
		useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		fileExists: (fileName): boolean => recorder.fileExists(fileName),
		readFile: (fileName): string | undefined => recorder.readFile(fileName),
		readDirectory: (...args): string[] => recorder.readDirectory(...args),
		getDirectories: (directory): string[] => [...recorder.getDirectories(directory)],
	};
	const parsed = ts.parseJsonConfigFileContent(configFile.config, parseHost, dirname(context.projectFilePath), undefined, context.projectFilePath);
	const fatalErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

	if (fatalErrors.length > 0) {
		const messages = fatalErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ');
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

const collectWorkspaceManifests = (recorder: RecorderType, rootDir: string): void => {
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

const collectRootMetadata = (recorder: RecorderType, rootDir: string): void => {
	for (const name of [...LOCKFILE_NAMES, ...WORKSPACE_INPUT_NAMES, 'package.json']) {
		const absolutePath = join(rootDir, name);
		recorder.fileExists(absolutePath);
		recorder.addInput(absolutePath);
	}
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

const publicManifest = (recorder: RecorderType): TypeScriptInputManifestType => {
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

const validateSnapshot = (recorder: RecorderType): void => {
	for (const input of recorder.snapshot.inputs.values()) {
		let bytes: Buffer;

		try {
			bytes = readFileSync(input.absolutePath);
		} catch {
			throw new Error(driftMessageOf(recorder.snapshot.rootDir, input.absolutePath));
		}

		if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) {
			throw new Error(driftMessageOf(recorder.snapshot.rootDir, input.absolutePath));
		}
	}

	for (const probe of recorder.snapshot.probes.values()) {
		if (probe.recompute() !== probe.value) {
			throw new Error(driftMessageOf(recorder.snapshot.rootDir, probe.absolutePath));
		}
	}
};

const watchInputsOf = (rootDir: string, manifest: TypeScriptInputManifestType): readonly string[] =>
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

const authoredCandidates = (
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

/**
 * Captures every input that can change extracted TypeScript facts.
 *
 * The snapshot owns configuration parsing, authored reads, reachable
 * declaration discovery, module-resolution probes, and manifest hashing.
 * Compiler and storage consumers must use its captured bytes.
 *
 * @param config - Resolved project configuration.
 * @param knownPaths - Files indexed by the current generation.
 * @returns The immutable snapshot and its parsed projects.
 * @throws {@link Error} When a project file is missing or invalid.
 */
export const createTypeScriptInputSnapshot = (config: AdapterConfigType, knownPaths: readonly string[] = []): CreatedTypeScriptInputSnapshotType => {
	const recorder = createRecorder(config.rootDir);

	collectRootMetadata(recorder, config.rootDir);
	const projects = config.projects.map((context) => parseProject(recorder, config.rootDir, context));
	collectWorkspaceManifests(recorder, config.rootDir);

	const authoredPaths = authoredCandidates(config, projects, knownPaths);

	for (const absolutePath of authoredPaths) {
		recorder.addInput(absolutePath);
	}

	collectReachableInputs(recorder, projects, authoredPaths);
	const manifest = publicManifest(recorder);

	debug('snapshot captured', {
		projects: projects.length,
		authored: authoredPaths.length,
		inputs: manifest.inputs.length,
		probes: manifest.probes.length,
		inputHash: manifest.inputHash,
	});

	const snapshot: TypeScriptInputSnapshotType = {
		manifest,
		readFile: recorder.readFile,
		readBytes: recorder.readBytes,
		fileExists: recorder.fileExists,
		directoryExists: recorder.directoryExists,
		getDirectories: recorder.getDirectories,
		readDirectory: recorder.readDirectory,
		realpath: recorder.realpath,
		projectOf: (projectFilePath) => recorder.snapshot.projectByPath.get(projectFilePath),
		validate: (): void => {
			validateSnapshot(recorder);
		},
	};

	return {snapshot, projects};
};

/**
 * Lists the manifest inputs the workspace watcher can observe.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param manifest - Captured input manifest.
 * @returns Workspace files and configuration inputs in path order.
 */
export const snapshotWatchInputs = (rootDir: string, manifest: TypeScriptInputManifestType): readonly string[] => watchInputsOf(rootDir, manifest);
