import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import {decodeSourceBytes} from '@codeindex/adapter-sdk';
import {isAuthoredSourceFile, isDeclarationFile, isInsideRoot} from './sourcePaths.ts';
import {type TypeScriptSnapshotProjectType} from './snapshotTypes.ts';

const {relative, resolve, sep} = path;

export const LOCKFILE_NAMES: readonly string[] = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];
export const WORKSPACE_INPUT_NAMES: readonly string[] = ['pnpm-workspace.yaml', '.npmrc', '.yarnrc.yml'];

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

type SnapshotInputKindType =
	| 'authored'
	| 'authored-declaration'
	| 'configuration'
	| 'manifest'
	| 'lockfile'
	| 'workspace'
	| 'external-declaration'
	| 'external-source'
	| 'compiler-lib';

export type SnapshotInputType = Readonly<{
	readonly absolutePath: string;
	readonly key: string;
	readonly kind: SnapshotInputKindType;
	readonly sha256: string;
}>;

type SnapshotProbeKindType = 'file' | 'directory' | 'directory-list' | 'stat';

export type SnapshotProbeType = Readonly<{
	readonly key: string;
	readonly kind: SnapshotProbeKindType;
	readonly value: string;
}>;

type SnapshotProbeInternalType = SnapshotProbeType &
	Readonly<{
		readonly absolutePath: string;
		readonly recompute: () => string;
	}>;

type MutableSnapshotType = {
	readonly rootDir: string;
	readonly contents: Map<string, Uint8Array>;
	readonly inputs: Map<string, SnapshotInputType>;
	readonly probes: Map<string, SnapshotProbeInternalType>;
	readonly projectByPath: Map<string, TypeScriptSnapshotProjectType>;
};

export type DirectoryEntriesType = Readonly<{
	readonly files: readonly string[];
	readonly directories: readonly string[];
	readonly symlinks: readonly string[];
}>;

export type RecorderType = Readonly<{
	snapshot: MutableSnapshotType;
	addInput: (absolutePath: string) => void;
	readFile: (absolutePath: string) => string | undefined;
	readBytes: (absolutePath: string) => Uint8Array | undefined;
	fileExists: (absolutePath: string) => boolean;
	directoryExists: (absolutePath: string) => boolean;
	entriesOf: (absolutePath: string) => DirectoryEntriesType;
	stat: (absolutePath: string) => Readonly<{mode: number; size: number; mtime: Date}> | undefined;
	getDirectories: (absolutePath: string) => readonly string[];
	realpath: (absolutePath: string) => string;
	/**
	 * Replaces incidental probes with a deterministic closure over the captured
	 * inputs.
	 *
	 * The compiler consults the filesystem through callbacks whose ordering and
	 * coverage vary between otherwise identical runs. Hashing that raw traffic
	 * would make the manifest identity unstable. After capture, the probe set is
	 * rebuilt from the inputs: each input exists, and its directory listing is
	 * observed, so a newly created sibling still invalidates the manifest while
	 * unchanged inputs always produce the same hash.
	 */
	sealProbes: () => void;
}>;

export const canonicalPath = (absolutePath: string): string => {
	try {
		return realpathSync(absolutePath);
	} catch {
		return resolve(absolutePath);
	}
};

export const keyOf = (rootDir: string, absolutePath: string): string =>
	isInsideRoot(rootDir, absolutePath)
		? `workspace:${relative(rootDir, absolutePath).split(sep).join('/')}`
		: `external:${createHash('sha256').update(absolutePath).digest('hex')}`;

const probeKeyOf = (rootDir: string, absolutePath: string): string => keyOf(rootDir, resolve(absolutePath));

const directoryListingOf = (absolutePath: string): string => {
	try {
		return hash(readdirSync(absolutePath).sort().join('\u0000'));
	} catch {
		return 'absent';
	}
};

const probeValueOf = (kind: SnapshotProbeKindType, absolutePath: string): string => {
	switch (kind) {
		case 'file': {
			return statSync(absolutePath, {throwIfNoEntry: false})?.isFile() === true ? 'present' : 'absent';
		}
		case 'directory': {
			return statSync(absolutePath, {throwIfNoEntry: false})?.isDirectory() === true ? 'present' : 'absent';
		}
		case 'directory-list': {
			return directoryListingOf(absolutePath);
		}
		case 'stat': {
			const stats = statSync(absolutePath, {throwIfNoEntry: false});

			return stats === undefined ? 'absent' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
		}
		default: {
			return 'absent';
		}
	}
};

const isCompilerLib = (absolutePath: string): boolean => /\/lib\.[^/]+\.d\.[cm]?ts$/u.test(absolutePath.split(sep).join('/'));

const classifyOf = (rootDir: string, absolutePath: string): SnapshotInputKindType => {
	const baseName = path.basename(absolutePath);
	const inside = isInsideRoot(rootDir, absolutePath);

	if (isCompilerLib(absolutePath)) {
		return 'compiler-lib';
	}

	if (baseName === 'package.json') {
		return 'manifest';
	}

	if (LOCKFILE_NAMES.includes(baseName)) {
		return 'lockfile';
	}

	if (WORKSPACE_INPUT_NAMES.includes(baseName)) {
		return 'workspace';
	}

	if (/^tsconfig(?:\..+)?\.json$/u.test(baseName) || /^jsconfig(?:\..+)?\.json$/u.test(baseName)) {
		return 'configuration';
	}

	if (isDeclarationFile(absolutePath)) {
		return inside ? 'authored-declaration' : 'external-declaration';
	}

	if (isAuthoredSourceFile(absolutePath, rootDir)) {
		return 'authored';
	}

	return 'external-source';
};

const recordProbe = (snapshot: MutableSnapshotType, absolutePath: string, kind: SnapshotProbeKindType): void => {
	const key = probeKeyOf(snapshot.rootDir, absolutePath);
	snapshot.probes.set(`${kind}\u0000${key}`, {
		key,
		kind,
		value: probeValueOf(kind, absolutePath),
		absolutePath: resolve(absolutePath),
		recompute: () => probeValueOf(kind, absolutePath),
	});
};

/**
 * Replaces incidental probes with a deterministic closure over the inputs.
 *
 * Each input is probed for existence and its directory is listed, so a newly
 * created sibling still invalidates the manifest while unchanged inputs always
 * produce the same set.
 *
 * @param snapshot - Mutable snapshot whose probe set is replaced.
 */
const sealSnapshotProbes = (snapshot: MutableSnapshotType): void => {
	const derived = new Map<string, SnapshotProbeInternalType>();
	const add = (absolutePath: string, kind: SnapshotProbeKindType): void => {
		const key = probeKeyOf(snapshot.rootDir, absolutePath);
		const mapKey = `${kind}\u0000${key}`;

		if (derived.has(mapKey)) {
			return;
		}

		derived.set(mapKey, {
			key,
			kind,
			value: probeValueOf(kind, absolutePath),
			absolutePath: resolve(absolutePath),
			recompute: () => probeValueOf(kind, absolutePath),
		});
	};

	for (const input of snapshot.inputs.values()) {
		add(input.absolutePath, 'file');
		add(path.dirname(input.absolutePath), 'directory-list');
	}

	snapshot.probes.clear();

	for (const [key, probe] of derived) {
		snapshot.probes.set(key, probe);
	}
};

/**
 * Creates the mutable recorder shared by configuration, resolution, and
 * compiler reads.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @returns A recorder whose reads are captured for the manifest and for later
 * compiler consumption.
 */
export const createRecorder = (rootDir: string): RecorderType => {
	const snapshot: MutableSnapshotType = {
		rootDir,
		contents: new Map(),
		inputs: new Map(),
		probes: new Map(),
		projectByPath: new Map(),
	};

	const readBytes = (absolutePath: string): Uint8Array | undefined => {
		const canonical = canonicalPath(absolutePath);
		const cached = snapshot.contents.get(canonical);

		if (cached !== undefined) {
			return cached;
		}

		if (statSync(canonical, {throwIfNoEntry: false})?.isFile() !== true) {
			return undefined;
		}

		const bytes = readFileSync(canonical);
		snapshot.contents.set(canonical, bytes);
		return bytes;
	};

	const addInput = (absolutePath: string): void => {
		const canonical = canonicalPath(absolutePath);
		const bytes = readBytes(canonical);

		if (bytes === undefined) {
			return;
		}

		if (!snapshot.inputs.has(canonical)) {
			snapshot.inputs.set(canonical, {absolutePath: canonical, key: keyOf(rootDir, canonical), kind: classifyOf(rootDir, canonical), sha256: hash(bytes)});
		}
	};

	const readFile = (absolutePath: string): string | undefined => {
		const bytes = readBytes(absolutePath);

		if (bytes === undefined) {
			return undefined;
		}

		addInput(absolutePath);
		return decodeSourceBytes(bytes);
	};

	const fileExists = (absolutePath: string): boolean => {
		recordProbe(snapshot, absolutePath, 'file');
		return statSync(absolutePath, {throwIfNoEntry: false})?.isFile() === true;
	};

	const directoryExists = (absolutePath: string): boolean => {
		recordProbe(snapshot, absolutePath, 'directory');
		return statSync(absolutePath, {throwIfNoEntry: false})?.isDirectory() === true;
	};

	const entriesOf = (absolutePath: string): DirectoryEntriesType => {
		recordProbe(snapshot, absolutePath, 'directory-list');

		try {
			const entries = readdirSync(absolutePath, {withFileTypes: true});
			const files: string[] = [];
			const directories: string[] = [];
			const symlinks: string[] = [];

			for (const entry of entries) {
				const candidate = resolve(absolutePath, entry.name);
				const isLink = entry.isSymbolicLink();
				const target = isLink ? statSync(candidate, {throwIfNoEntry: false}) : undefined;

				if (entry.isDirectory() || target?.isDirectory() === true) {
					directories.push(entry.name);
				} else if (entry.isFile() || target?.isFile() === true) {
					files.push(entry.name);
				}

				if (isLink) {
					symlinks.push(entry.name);
				}
			}

			return {files: files.sort(), directories: directories.sort(), symlinks: symlinks.sort()};
		} catch {
			return {files: [], directories: [], symlinks: []};
		}
	};

	const getDirectories = (absolutePath: string): readonly string[] => entriesOf(absolutePath).directories;

	const stat = (absolutePath: string): Readonly<{mode: number; size: number; mtime: Date}> | undefined => {
		recordProbe(snapshot, absolutePath, 'stat');

		const stats = statSync(absolutePath, {throwIfNoEntry: false});

		return stats === undefined ? undefined : {mode: stats.mode, size: stats.size, mtime: stats.mtime};
	};

	const sealProbes = (): void => {
		sealSnapshotProbes(snapshot);
	};

	return {snapshot, addInput, readFile, readBytes, fileExists, directoryExists, entriesOf, stat, getDirectories, realpath: canonicalPath, sealProbes};
};
