import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {decodeSourceBytes} from '../../core/generation/sourceFiles.ts';
import {isDeclarationFile, isInsideRoot, PUBLISHABLE_EXTENSIONS} from './sourcePaths.ts';
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

type SnapshotProbeKindType = 'file' | 'directory' | 'directory-list' | 'read-directory';

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

export type ReadDirectoryInputType = readonly [
	directory: string,
	extensions: readonly string[],
	excludes: readonly string[] | undefined,
	includes: readonly string[],
	depth?: number,
];

export type RecorderType = Readonly<{
	snapshot: MutableSnapshotType;
	addInput: (absolutePath: string) => void;
	readFile: (absolutePath: string) => string | undefined;
	readBytes: (absolutePath: string) => Uint8Array | undefined;
	fileExists: (absolutePath: string) => boolean;
	directoryExists: (absolutePath: string) => boolean;
	getDirectories: (absolutePath: string) => readonly string[];
	readDirectory: (...input: ReadDirectoryInputType) => string[];
	realpath: (absolutePath: string) => string;
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
		case 'read-directory': {
			return 'absent';
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

	if (inside && PUBLISHABLE_EXTENSIONS.some((extension) => absolutePath.endsWith(extension))) {
		return 'authored';
	}

	return 'external-source';
};

export const isResolutionSource = (absolutePath: string): boolean =>
	!isCompilerLib(absolutePath) && (PUBLISHABLE_EXTENSIONS.some((extension) => absolutePath.endsWith(extension)) || isDeclarationFile(absolutePath));

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

	const getDirectories = (absolutePath: string): readonly string[] => {
		recordProbe(snapshot, absolutePath, 'directory-list');

		try {
			return readdirSync(absolutePath, {withFileTypes: true})
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			return [];
		}
	};

	const readDirectory = (...[directory, extensions, excludes, includes, depth]: ReadDirectoryInputType): string[] => {
		const files = ts.sys.readDirectory(directory, extensions, excludes, includes, depth);
		const key = hash(JSON.stringify({directory, extensions, excludes, includes, depth}));
		const value = hash([...files].sort().join('\u0000'));

		snapshot.probes.set(`read-directory\u0000${key}`, {
			key,
			kind: 'read-directory',
			value,
			absolutePath: resolve(directory),
			recompute: () => hash([...ts.sys.readDirectory(directory, extensions, excludes, includes, depth)].sort().join('\u0000')),
		});

		return files;
	};

	return {snapshot, addInput, readFile, readBytes, fileExists, directoryExists, getDirectories, readDirectory, realpath: canonicalPath};
};
