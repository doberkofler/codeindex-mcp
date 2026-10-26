import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {defaultSchemaName} from './name.ts';

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'coverage', 'temp', '.vite']);

const {isAbsolute, join, relative, sep} = path;

export const DEFAULT_ORACLE_SOURCE_EXTENSIONS: readonly string[] = ['.pks', '.pkg', '.pkb', '.prc', '.fnc'];

const EXTENSION_PATTERN = /^\.[a-z0-9]+$/u;

const OracleManifestSchema = z.object({
	schemaVersion: z.literal(1),
	dialect: z.literal('19c'),
	defaultSchema: z.string().min(1),
	extensions: z
		.array(z.string().regex(EXTENSION_PATTERN))
		.min(1)
		.default(() => [...DEFAULT_ORACLE_SOURCE_EXTENSIONS]),
	include: z.array(z.string().min(1)).min(1),
	exclude: z.array(z.string().min(1)).default([]),
});

export type OracleManifestType = z.infer<typeof OracleManifestSchema>;

export type OracleManifestFileType = Readonly<{
	manifest: OracleManifestType;
	manifestPath: string;
	manifestBytes: string;
	canonicalSchema: string;
}>;

type OracleDiscoveredFileType = Readonly<{
	absolutePath: string;
	relativePath: string;
}>;

export type OracleDiscoveryType = Readonly<{
	files: readonly OracleDiscoveredFileType[];
	excludedFileCount: number;
}>;

const isSafePattern = (pattern: string): boolean => !isAbsolute(pattern) && !pattern.includes('\\') && !pattern.split('/').includes('..');

/**
 * Validates one Oracle project manifest.
 *
 * @param source - Untrusted parsed JSON value.
 * @returns The validated manifest.
 * @throws {@link Error} When the manifest shape or a pattern is invalid.
 */
export const parseOracleManifest = (source: unknown): OracleManifestType => {
	const parsed = OracleManifestSchema.safeParse(source);

	if (!parsed.success) {
		throw new Error(`Invalid Oracle manifest:\n${z.prettifyError(parsed.error)}`);
	}

	for (const pattern of [...parsed.data.include, ...parsed.data.exclude]) {
		if (!isSafePattern(pattern)) {
			throw new Error(`Invalid Oracle manifest pattern; expected a workspace-relative POSIX glob: ${pattern}`);
		}
	}

	return parsed.data;
};

/**
 * Reads and validates one configured Oracle manifest.
 *
 * @param manifestPath - Absolute manifest file path.
 * @returns The validated manifest and its raw bytes.
 */
export const readOracleManifest = (manifestPath: string): OracleManifestFileType => {
	const manifestBytes = readFileSync(manifestPath, 'utf8');
	let parsed: unknown;

	try {
		parsed = JSON.parse(manifestBytes);
	} catch (error) {
		throw new Error(`Oracle manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
	}

	const manifest = parseOracleManifest(parsed);

	return {manifest, manifestPath, manifestBytes, canonicalSchema: defaultSchemaName(manifest.defaultSchema)};
};

/**
 * Reports whether a workspace-relative path matches the manifest.
 *
 * @param relativePath - Workspace-relative POSIX path.
 * @param manifest - Validated Oracle manifest.
 * @returns Whether the file is included and not excluded.
 */
export const matchesOracleManifest = (relativePath: string, manifest: OracleManifestType): boolean => {
	if (!manifest.extensions.some((extension) => relativePath.endsWith(extension))) {
		return false;
	}

	const included = manifest.include.some((pattern) => path.matchesGlob(relativePath, pattern));

	if (!included) {
		return false;
	}

	return !manifest.exclude.some((pattern) => path.matchesGlob(relativePath, pattern));
};

/**
 * Reports whether a path has an extension the Oracle adapter can publish.
 *
 * @param absolutePath - Candidate absolute path.
 * @param extensions - Supported extension set.
 * @returns Whether the extension is supported.
 */
export const isOracleSourcePath = (absolutePath: string, extensions: readonly string[] = DEFAULT_ORACLE_SOURCE_EXTENSIONS): boolean =>
	extensions.some((extension) => absolutePath.endsWith(extension));

const walk = (directory: string, files: string[]): void => {
	for (const entry of readdirSync(directory, {withFileTypes: true})) {
		const absolutePath = join(directory, entry.name);

		if (entry.isDirectory()) {
			if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
				walk(absolutePath, files);
			}
		} else if (entry.isFile()) {
			files.push(absolutePath);
		}
	}
};

/**
 * Discovers deterministic, real-path source matches for one manifest.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param manifest - Validated Oracle manifest.
 * @returns Included files and the count of supported files excluded by the manifest.
 */
export const discoverOracleFiles = (rootDir: string, manifest: OracleManifestType): OracleDiscoveryType => {
	const candidates: string[] = [];
	walk(rootDir, candidates);
	const realRoot = realpathSync(rootDir);
	const files: OracleDiscoveredFileType[] = [];
	let excludedFileCount = 0;

	for (const candidate of candidates.sort()) {
		if (!isOracleSourcePath(candidate, manifest.extensions)) {
			continue;
		}

		const realCandidate = realpathSync(candidate);
		const relativeToRoot = relative(realRoot, realCandidate);

		if (relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === '..' || isAbsolute(relativeToRoot)) {
			excludedFileCount += 1;
			continue;
		}

		const relativePath = relativeToRoot.split(sep).join('/');

		if (matchesOracleManifest(relativePath, manifest)) {
			files.push({absolutePath: realCandidate, relativePath});
		} else {
			excludedFileCount += 1;
		}
	}

	return {files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)), excludedFileCount};
};

type ManifestHashInputType = Readonly<{
	manifestBytes: string;
	canonicalSchema: string;
	include: readonly string[];
	exclude: readonly string[];
	extensions: readonly string[];
	parserRevision: string;
}>;

/**
 * Hashes the manifest and every input that affects parsing.
 *
 * @param input - Manifest bytes, schema, pattern set, parser identity, and file records.
 * @returns A deterministic configuration hash.
 */
export const oracleManifestHash = (input: ManifestHashInputType & Readonly<{files: readonly Readonly<{path: string; sha256: string}>[]}>): string =>
	createHash('sha256')
		.update(
			[
				input.manifestBytes,
				input.canonicalSchema,
				`include:${input.include.join(',')}`,
				`exclude:${input.exclude.join(',')}`,
				`extensions:${input.extensions.join(',')}`,
				`parser:${input.parserRevision}`,
				...input.files.map((file) => `${file.path}\u0000${file.sha256}`),
			].join('\n'),
		)
		.digest('hex');

/**
 * Hashes only the configuration inputs that affect parsing.
 *
 * Source content is deliberately excluded: this hash keys per-file extraction
 * artifacts, so including file hashes would invalidate every artifact on every
 * edit and defeat reuse. The generation configuration hash keeps the content
 * dependency and the published identity unchanged.
 *
 * @param input - Manifest bytes, schema, pattern set, and parser identity.
 * @returns A content-independent artifact context hash.
 */
export const oracleArtifactContextHash = (input: ManifestHashInputType): string =>
	createHash('sha256')
		.update(
			[
				input.manifestBytes,
				input.canonicalSchema,
				`include:${input.include.join(',')}`,
				`exclude:${input.exclude.join(',')}`,
				`extensions:${input.extensions.join(',')}`,
				`parser:${input.parserRevision}`,
			].join('\n'),
		)
		.digest('hex');
