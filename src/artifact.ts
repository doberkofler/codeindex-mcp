import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, readdirSync, readlinkSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {hashOf} from './hash.ts';
import {type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';

/** One hashed artifact file. Paths are POSIX and relative to the artifact root. */
export type ArtifactEntryType = Readonly<{path: string; digest: string; size: number}>;

/** Verified identity of one staged MCP artifact. */
export type ArtifactIdentityType = Readonly<{
	treatmentId: TreatmentIdType;
	id: string;
	/** Artifact directory relative to the harness root. */
	root: string;
	entryPoint: string;
	/** Computed content digest over every artifact file except `node_modules`. */
	digest: string;
	/** Digest declared by the suite, or null when the suite pins no digest. */
	declaredDigest: string | null;
	fileCount: number;
	sizeBytes: number;
	/** Runtime dependency names declared by the artifact package. */
	dependencies: readonly string[];
}>;

/** Artifact identity recorded in a manifest or a result. */
export type ArtifactRefType = Readonly<{id: string; digest: string}>;

/** Directories that are never part of an artifact content digest. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git']);

const digestOfFile = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

const entriesOf = (root: string, relative = ''): readonly ArtifactEntryType[] => {
	const directory = relative === '' ? root : path.join(root, relative);
	const entries: ArtifactEntryType[] = [];

	for (const name of readdirSync(directory).sort()) {
		if (IGNORED_DIRECTORIES.has(name)) {
			continue;
		}

		const child = relative === '' ? name : `${relative}/${name}`;
		const absolute = path.join(root, child);
		const stats = lstatSync(absolute);

		if (stats.isDirectory()) {
			entries.push(...entriesOf(root, child));

			continue;
		}

		if (stats.isSymbolicLink()) {
			// A link is identified by its target text, never by the content it
			// resolves to: the same artifact must hash identically wherever it is
			// staged.
			entries.push({path: child, digest: hashOf({symlink: readlinkSync(absolute)}), size: 0});

			continue;
		}

		entries.push({path: child, digest: digestOfFile(absolute), size: stats.size});
	}

	return entries;
};

/**
 * Lists and hashes every file of one artifact tree.
 *
 * `node_modules` and `.git` are excluded: dependencies are verified separately
 * and a staged tree is identified by its own files only.
 *
 * @param root - Absolute artifact root.
 * @returns Sorted entries with per-file digests.
 */
export const artifactEntriesOf = (root: string): readonly ArtifactEntryType[] => entriesOf(root);

/**
 * Reads the runtime dependency names declared by an artifact package.
 *
 * @param root - Absolute artifact root.
 * @returns Sorted dependency names.
 */
export const artifactDependenciesOf = (root: string): readonly string[] => {
	const file = path.join(root, 'package.json');

	if (!existsSync(file)) {
		throw new Error(`artifact package is missing ${file}`);
	}

	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`artifact package at ${file} is not a JSON object`);
	}

	const declared = (parsed as Record<string, unknown>)['dependencies'];

	if (declared === undefined) {
		return [];
	}

	if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
		throw new Error(`artifact package at ${file} declares a non-object "dependencies" field`);
	}

	return Object.keys(declared).sort();
};

/**
 * Resolves every declared artifact dependency from the artifact root.
 *
 * The check is a real module resolution, so a missing or incomplete staged
 * `node_modules` is rejected before a model starts rather than when the MCP
 * entry first imports a module.
 *
 * @param root - Absolute artifact root.
 * @param dependencies - Declared dependency names.
 * @returns Names that do not resolve.
 */
export const unresolvedDependenciesOf = (root: string, dependencies: readonly string[]): readonly string[] => {
	const requireFromArtifact = createRequire(path.join(root, 'package.json'));

	return dependencies.filter((name) => {
		try {
			requireFromArtifact.resolve(name);

			return false;
		} catch {
			return true;
		}
	});
};

/**
 * Verifies one staged artifact and derives its identity.
 *
 * The verification runs before any model process: a missing entry point, a
 * missing dependency, or a digest that contradicts the suite is a hard
 * rejection.
 *
 * @param artifactRoot - Absolute artifact root.
 * @param treatment - CodeIndex treatment that presents the artifact.
 * @returns The verified identity.
 */
export const artifactIdentityOf = (
	artifactRoot: string,
	treatment: TreatmentDefinitionType,
): ArtifactIdentityType => {
	const artifact = treatment.artifact;

	if (artifact === null) {
		throw new Error(`treatment ${treatment.id} declares no CodeIndex artifact`);
	}

	const entryPoint = path.join(artifactRoot, artifact.entryPoint);

	if (!existsSync(entryPoint)) {
		throw new Error(`artifact ${artifact.id} entry point is missing: ${entryPoint}`);
	}

	const dependencies = artifactDependenciesOf(artifactRoot);
	const unresolved = unresolvedDependenciesOf(artifactRoot, dependencies);

	if (unresolved.length > 0) {
		throw new Error(`artifact ${artifact.id} is missing dependencies: ${unresolved.join(', ')}`);
	}

	const entries = artifactEntriesOf(artifactRoot);
	const digest = hashOf(
		entries.map((entry) => ({
			path: entry.path,
			digest: entry.digest,
		})),
	);

	if (artifact.digest !== null && artifact.digest !== digest) {
		throw new Error(
			`artifact ${artifact.id} digest mismatch: suite pins ${artifact.digest}, staged tree hashes to ${digest}`,
		);
	}

	return {
		treatmentId: treatment.id,
		id: artifact.id,
		root: artifact.root,
		entryPoint: artifact.entryPoint,
		digest,
		declaredDigest: artifact.digest,
		fileCount: entries.length,
		sizeBytes: entries.reduce((total, entry) => total + entry.size, 0),
		dependencies,
	};
};

/**
 * Projects a verified identity into the reference recorded in records.
 *
 * @param identity - Verified artifact identity, or null for a treatment without an artifact.
 * @returns `{id, digest}` or null.
 */
export const artifactRefOf = (identity: ArtifactIdentityType | null): ArtifactRefType | null =>
	identity === null ? null : {id: identity.id, digest: identity.digest};
