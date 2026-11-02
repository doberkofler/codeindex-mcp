import type ts from 'typescript';
import {type SnapshotInputType, type SnapshotProbeType, type ReadDirectoryInputType} from './snapshotRecorder.ts';

export type TypeScriptInputManifestType = Readonly<{
	readonly inputs: readonly SnapshotInputType[];
	readonly probes: readonly SnapshotProbeType[];
	readonly inputHash: string;
}>;

/** One parsed project owned by the snapshot. */
export type TypeScriptSnapshotProjectType = Readonly<{
	readonly name: string;
	readonly projectFilePath: string;
	readonly projectFileBytes: string;
	readonly parsed: ts.ParsedCommandLine;
	readonly declaredCompilerVersion: string | null;
}>;

export type TypeScriptInputSnapshotType = Readonly<{
	readonly manifest: TypeScriptInputManifestType;
	readonly readFile: (absolutePath: string) => string | undefined;
	readonly readBytes: (absolutePath: string) => Uint8Array | undefined;
	readonly fileExists: (absolutePath: string) => boolean;
	readonly directoryExists: (absolutePath: string) => boolean;
	readonly getDirectories: (absolutePath: string) => readonly string[];
	readonly readDirectory: (...input: ReadDirectoryInputType) => string[];
	readonly realpath: (absolutePath: string) => string;
	readonly projectOf: (projectFilePath: string) => TypeScriptSnapshotProjectType | undefined;
	/**
	 * Re-reads every recorded input and probe.
	 *
	 * @throws {Error} When any captured input changed or a newly created path
	 * would change module resolution.
	 */
	readonly validate: () => void;
}>;

export type CreatedTypeScriptInputSnapshotType = Readonly<{
	readonly snapshot: TypeScriptInputSnapshotType;
	readonly projects: readonly TypeScriptSnapshotProjectType[];
}>;
