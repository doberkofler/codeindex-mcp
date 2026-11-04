import type * as ts from './compiler.ts';
import {type SnapshotInputType, type SnapshotProbeType} from './snapshotRecorder.ts';

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
	readonly realpath: (absolutePath: string) => string;
	readonly projectOf: (projectFilePath: string) => TypeScriptSnapshotProjectType | undefined;
	/**
	 * The program materialised for one configured project.
	 *
	 * Program construction is also the snapshot's resolution pass, so callers
	 * reuse this program instead of creating a second one. The snapshot owns it;
	 * consumers must not dispose it.
	 */
	readonly programOf: (projectFilePath: string) => ts.Program | undefined;
	/**
	 * Compiler API process bound to this snapshot's captured filesystem.
	 *
	 * The snapshot owns the process; consumers must not dispose it.
	 */
	readonly api: ts.API;
	/**
	 * Re-reads every recorded input and probe.
	 *
	 * @throws {Error} When any captured input changed or a newly created path
	 * would change module resolution.
	 */
	readonly validate: () => void;
	/** Releases the retained programs and the compiler API process. */
	readonly dispose: () => void;
}>;

export type CreatedTypeScriptInputSnapshotType = Readonly<{
	readonly snapshot: TypeScriptInputSnapshotType;
	readonly projects: readonly TypeScriptSnapshotProjectType[];
}>;
