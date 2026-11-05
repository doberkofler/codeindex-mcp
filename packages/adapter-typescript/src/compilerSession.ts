import {readFileSync} from 'node:fs';
import path from 'node:path';
import * as ts from './compiler.ts';
import {z} from 'zod';
import {type AdapterConfigType, debugFor} from '@codeindex/adapter-sdk';
import {createRecorder, LOCKFILE_NAMES, WORKSPACE_INPUT_NAMES, type RecorderType} from './snapshotRecorder.ts';
import {recorderFileSystem} from './compilerFileSystem.ts';
import {materializeProjectPrograms, recordProgramInputs} from './snapshotResolution.ts';
import {
	type CreatedTypeScriptInputSnapshotType,
	type TypeScriptInputManifestType,
	type TypeScriptInputSnapshotType,
	type TypeScriptSnapshotProjectType,
} from './snapshotTypes.ts';
import {
	addCurrentInputs,
	authoredCandidates,
	collectWorkspaceManifests,
	fileNamesOf,
	hashOf,
	parseProject,
	programsOf,
	projectFileHashesOf,
	publicManifest,
	rootMetadataOf,
	sameArray,
	sameMap,
	validateSnapshot,
	watchInputsOf,
} from './snapshotCapture.ts';

const debug = debugFor('snapshot');
const {join} = path;
const DEFAULT_WARM_IDLE_MS = 60_000;

const WarmOptionsSchema = z
	.object({
		/** Milliseconds a compiler session may stay idle before it is disposed. Zero disables eviction. */
		warmIdleMs: z.number().int().min(0).max(3_600_000).optional(),
	})
	.loose();

type WarmStateType = {
	readonly key: string;
	readonly rootDir: string;
	readonly recorder: RecorderType;
	readonly api: ts.API;
	snapshot: ts.Snapshot;
	projects: readonly TypeScriptSnapshotProjectType[];
	programs: ReadonlyMap<string, ts.Program>;
	manifest: TypeScriptInputManifestType;
	projectFileHashes: ReadonlyMap<string, string>;
	rootMetadata: ReadonlyMap<string, string | null>;
	fileNames: readonly string[];
	authoredPaths: ReadonlySet<string>;
	warmIdleMs: number;
	leases: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
};

type AuthoredChangesType = Readonly<{
	authoredPaths: ReadonlySet<string>;
	changed: readonly string[];
	created: readonly string[];
	deleted: readonly string[];
}>;

const sessions = new Map<string, WarmStateType>();
const metrics = {created: 0, reused: 0, evicted: 0};

export type TypeScriptWarmSessionMetricsType = Readonly<{
	readonly sessions: number;
	readonly created: number;
	readonly reused: number;
	readonly evicted: number;
}>;

/**
 * Reports warm-session lifecycle counters for diagnostics and tests.
 *
 * @returns Session count and cumulative create, reuse, and eviction counts.
 */
export const typeScriptWarmSessionMetrics = (): TypeScriptWarmSessionMetricsType => ({sessions: sessions.size, ...metrics});

const warmIdleMsOf = (config: AdapterConfigType): number => {
	const parsed = WarmOptionsSchema.safeParse(config.extractorOptions);
	return parsed.success ? (parsed.data.warmIdleMs ?? DEFAULT_WARM_IDLE_MS) : DEFAULT_WARM_IDLE_MS;
};

const sessionKeyOf = (config: AdapterConfigType): string =>
	[config.rootDir, ...config.projects.map((project) => project.projectFilePath).sort()].join('\u0000');

const createWarmState = (config: AdapterConfigType, knownPaths: readonly string[]): WarmStateType => {
	const key = sessionKeyOf(config);
	const recorder = createRecorder(config.rootDir);
	const api = new ts.API({cwd: config.rootDir, fs: recorderFileSystem(recorder)});
	let snapshot: ts.Snapshot | undefined;

	try {
		const rootMetadata = rootMetadataOf(recorder, config.rootDir);
		const projects = config.projects.map((context) => parseProject(api, recorder, config.rootDir, context));

		collectWorkspaceManifests(recorder, config.rootDir);
		const {snapshot: createdSnapshot, programs} = materializeProjectPrograms(api, recorder, projects);
		snapshot = createdSnapshot;
		const authoredPaths = addCurrentInputs({recorder, config, projects, programs, knownPaths});

		recorder.sealProbes();
		const manifest = publicManifest(recorder);
		recorder.retainOnly(manifest.inputs.map((input) => input.absolutePath));
		metrics.created += 1;

		debug('snapshot captured', {
			projects: projects.length,
			authored: authoredPaths.size,
			inputs: manifest.inputs.length,
			probes: manifest.probes.length,
			inputHash: manifest.inputHash,
		});

		return {
			key,
			rootDir: config.rootDir,
			recorder,
			api,
			snapshot: createdSnapshot,
			projects,
			programs,
			manifest,
			projectFileHashes: projectFileHashesOf(projects),
			rootMetadata,
			fileNames: fileNamesOf(projects),
			authoredPaths,
			warmIdleMs: warmIdleMsOf(config),
			leases: 0,
			idleTimer: null,
			disposed: false,
		};
	} catch (error) {
		snapshot?.[Symbol.dispose]();
		api[Symbol.dispose]();
		throw error;
	}
};

const assertWarmInputsUnchanged = (state: WarmStateType, config: AdapterConfigType): readonly TypeScriptSnapshotProjectType[] => {
	state.recorder.resetMetadata();
	state.recorder.invalidate([
		...LOCKFILE_NAMES.map((name) => join(state.rootDir, name)),
		...WORKSPACE_INPUT_NAMES.map((name) => join(state.rootDir, name)),
		join(state.rootDir, 'package.json'),
		...config.projects.map((project) => project.projectFilePath),
	]);

	const rootMetadata = rootMetadataOf(state.recorder, state.rootDir);

	if (!sameMap(state.rootMetadata, rootMetadata)) {
		throw new Error('TypeScript workspace inputs changed');
	}

	const projects = config.projects.map((context) => parseProject(state.api, state.recorder, state.rootDir, context));

	if (!sameMap(state.projectFileHashes, projectFileHashesOf(projects))) {
		throw new Error('TypeScript project file changed');
	}

	if (!sameArray(state.fileNames, fileNamesOf(projects))) {
		throw new Error('TypeScript project file set changed');
	}

	for (const input of state.manifest.inputs) {
		if (input.kind === 'authored') {
			continue;
		}

		let bytes: Buffer;

		try {
			bytes = readFileSync(input.absolutePath);
		} catch {
			throw new Error('TypeScript declaration or configuration input disappeared');
		}

		if (hashOf(bytes) !== input.sha256) {
			throw new Error('TypeScript declaration or configuration input changed');
		}
	}

	state.rootMetadata = rootMetadata;
	return projects;
};

const previousAuthoredHashOf = (state: WarmStateType, absolutePath: string): string | null =>
	state.manifest.inputs.find((input) => input.absolutePath === absolutePath)?.sha256 ?? null;

const authoredChangesOf = (
	state: WarmStateType,
	config: AdapterConfigType,
	projects: readonly TypeScriptSnapshotProjectType[],
	knownPaths: readonly string[],
): AuthoredChangesType => {
	const authoredPaths = new Set(authoredCandidates(config, projects, knownPaths));
	const changed: string[] = [];
	const created: string[] = [];

	for (const absolutePath of authoredPaths) {
		if (!state.authoredPaths.has(absolutePath)) {
			created.push(absolutePath);
		} else if (hashOf(readFileSync(absolutePath)) !== previousAuthoredHashOf(state, absolutePath)) {
			changed.push(absolutePath);
		}
	}

	const deleted = [...state.authoredPaths].filter((absolutePath) => !authoredPaths.has(absolutePath));
	return {authoredPaths, changed, created, deleted};
};

const applyAuthoredChanges = (
	state: WarmStateType,
	projects: readonly TypeScriptSnapshotProjectType[],
	changes: AuthoredChangesType,
): ReadonlyMap<string, ts.Program> => {
	if (changes.changed.length === 0 && changes.created.length === 0 && changes.deleted.length === 0) {
		return state.programs;
	}

	state.recorder.invalidate([...changes.changed, ...changes.created, ...changes.deleted]);
	const updated = state.snapshot.update({
		fileNotifications: {changed: [...changes.changed], created: [...changes.created], deleted: [...changes.deleted]},
		ensurePrograms: true,
	});

	if (updated !== state.snapshot) {
		state.snapshot[Symbol.dispose]();
		state.snapshot = updated;
	}

	return programsOf(state.snapshot, projects);
};

const rebuildWarmManifest = (
	state: WarmStateType,
	projects: readonly TypeScriptSnapshotProjectType[],
	programs: ReadonlyMap<string, ts.Program>,
	authoredPaths: ReadonlySet<string>,
): void => {
	for (const input of state.manifest.inputs) {
		if (input.kind !== 'authored') {
			state.recorder.addInput(input.absolutePath);
		}
	}

	for (const absolutePath of authoredPaths) {
		state.recorder.addInput(absolutePath);
	}

	recordProgramInputs(state.recorder, programs.values());
	state.recorder.sealProbes();
	state.manifest = publicManifest(state.recorder);
	state.recorder.retainOnly(state.manifest.inputs.map((input) => input.absolutePath));
	state.projects = projects;
	state.programs = programs;
	state.projectFileHashes = projectFileHashesOf(projects);
	state.fileNames = fileNamesOf(projects);
	state.authoredPaths = authoredPaths;
};

const refreshWarmState = (state: WarmStateType, config: AdapterConfigType, knownPaths: readonly string[]): void => {
	const projects = assertWarmInputsUnchanged(state, config);
	const changes = authoredChangesOf(state, config, projects, knownPaths);
	const programs = applyAuthoredChanges(state, projects, changes);

	rebuildWarmManifest(state, projects, programs, changes.authoredPaths);
	state.warmIdleMs = warmIdleMsOf(config);
	debug('snapshot updated', {
		changed: changes.changed.length,
		created: changes.created.length,
		deleted: changes.deleted.length,
		inputs: state.manifest.inputs.length,
		inputHash: state.manifest.inputHash,
	});
};

const clearIdleTimer = (state: WarmStateType): void => {
	if (state.idleTimer !== null) {
		clearTimeout(state.idleTimer);
		state.idleTimer = null;
	}
};

const disposeWarmState = (state: WarmStateType): void => {
	if (state.disposed) {
		return;
	}

	state.disposed = true;
	clearIdleTimer(state);
	metrics.evicted += 1;

	try {
		state.snapshot[Symbol.dispose]();
	} finally {
		state.programs = new Map<string, ts.Program>();
		state.recorder.retainOnly([]);

		try {
			state.api[Symbol.dispose]();
		} finally {
			if (sessions.get(state.key) === state) {
				sessions.delete(state.key);
			}
		}
	}
};

const scheduleIdleEviction = (state: WarmStateType): void => {
	clearIdleTimer(state);

	if (state.warmIdleMs === 0 || state.disposed) {
		return;
	}

	state.idleTimer = setTimeout(() => {
		state.idleTimer = null;

		if (state.leases === 0) {
			debug('warm compiler session evicted', {rootDir: state.rootDir});
			disposeWarmState(state);
		}
	}, state.warmIdleMs);
	state.idleTimer.unref();
};

const releaseWarmState = (state: WarmStateType): void => {
	state.leases = Math.max(0, state.leases - 1);

	if (state.leases === 0) {
		scheduleIdleEviction(state);
	}
};

const snapshotView = (state: WarmStateType): TypeScriptInputSnapshotType => {
	let released = false;

	return {
		manifest: state.manifest,
		readFile: state.recorder.readFile,
		readBytes: state.recorder.readBytes,
		fileExists: state.recorder.fileExists,
		directoryExists: state.recorder.directoryExists,
		getDirectories: state.recorder.getDirectories,
		realpath: state.recorder.realpath,
		projectOf: (projectFilePath) => state.recorder.snapshot.projectByPath.get(projectFilePath),
		programOf: (projectFilePath) => state.programs.get(projectFilePath),
		api: state.api,
		validate: (): void => {
			validateSnapshot(state.recorder);
		},
		dispose: (): void => {
			if (released) {
				return;
			}

			released = true;
			releaseWarmState(state);
		},
	};
};

/**
 * Releases every idle compiler session owned by this process.
 *
 * The build worker calls this on shutdown so the compiler child process and its
 * snapshots do not outlive the worker.
 */
export const disposeTypeScriptSessions = (): void => {
	for (const state of sessions.values()) {
		disposeWarmState(state);
	}
};

/**
 * Captures every input that can change extracted TypeScript facts.
 *
 * Consecutive calls in one process reuse one compiler snapshot. The snapshot is
 * updated in place with `Snapshot.update` when only authored source files
 * changed, and rebuilt when project files, compiler identity, lockfiles, or
 * declaration inputs changed. Compiler and storage consumers must use the
 * captured bytes returned by the snapshot view.
 *
 * @param config - Resolved project configuration.
 * @param knownPaths - Files indexed by the current generation.
 * @returns The immutable snapshot and its parsed projects.
 * @throws {@link Error} When a project file is missing or invalid.
 */
export const createTypeScriptInputSnapshot = (config: AdapterConfigType, knownPaths: readonly string[] = []): CreatedTypeScriptInputSnapshotType => {
	const key = sessionKeyOf(config);
	let state = sessions.get(key);

	if (state !== undefined) {
		try {
			refreshWarmState(state, config, knownPaths);
			metrics.reused += 1;
		} catch (error) {
			debug('warm snapshot rebuild', {rootDir: config.rootDir, reason: error instanceof Error ? error.message : String(error)});
			disposeWarmState(state);
			state = undefined;
		}
	}

	if (state === undefined) {
		state = createWarmState(config, knownPaths);
		sessions.set(key, state);
	}

	clearIdleTimer(state);
	state.leases += 1;

	return {snapshot: snapshotView(state), projects: state.projects};
};

/**
 * Lists the manifest inputs the workspace watcher can observe.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param manifest - Captured input manifest.
 * @returns Workspace files and configuration inputs in path order.
 */
export const snapshotWatchInputs = (rootDir: string, manifest: TypeScriptInputManifestType): readonly string[] => watchInputsOf(rootDir, manifest);
