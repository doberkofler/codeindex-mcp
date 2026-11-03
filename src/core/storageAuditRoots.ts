import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {type StorageAuditRootsType} from './storageAuditTypes.ts';

const {join, relative, resolve, sep} = path;

const ConfigSchema = z.object({
	storage: z.object({directory: z.string().min(1).optional()}).optional(),
});

const uniquePaths = (values: readonly string[]): readonly string[] => [...new Set(values.map((value) => resolve(value)))];

const canonicalPath = (value: string): string => {
	const absolute = resolve(value);

	return existsSync(absolute) ? realpathSync(absolute) : absolute;
};

const isInside = (parent: string, candidate: string): boolean => {
	const relativePath = relative(resolve(parent), resolve(candidate));

	return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
};

const relativeSegments = (parent: string, candidate: string): string => relative(resolve(parent), resolve(candidate)).split(sep).join('/');

/**
 * Normalizes one path for retained output.
 *
 * The repository prefix wins over the home prefix so a checkout below the home
 * directory is reported as `$REPO`, not `$HOME/...`.
 *
 * @param target - Absolute path to normalize.
 * @param roots - Home and repository prefixes.
 * @returns `$REPO`/`$HOME`-relative POSIX path, or the absolute path outside both.
 */
export const normalizeAuditPath = (target: string, roots: Readonly<{home: string; repository: string}>): string => {
	const absolute = resolve(target);

	if (isInside(roots.repository, absolute)) {
		const suffix = relativeSegments(roots.repository, absolute);

		return suffix.length === 0 ? '$REPO' : `$REPO/${suffix}`;
	}

	if (isInside(roots.home, absolute)) {
		const suffix = relativeSegments(roots.home, absolute);

		return suffix.length === 0 ? '$HOME' : `$HOME/${suffix}`;
	}

	return absolute;
};

const configuredStorageRoot = (input: Readonly<{repository: string; environment: NodeJS.ProcessEnv}>): string | null => {
	const configuredPath = input.environment['CODE_INDEX_CONFIG'];
	const configPath = configuredPath === undefined ? join(input.repository, 'codeindex.config.json') : resolve(input.repository, configuredPath);

	if (!existsSync(configPath)) {
		return null;
	}

	const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
	const parsed = ConfigSchema.safeParse(raw);

	if (!parsed.success) {
		throw new Error(`Invalid storage audit configuration ${configPath}:\n${z.prettifyError(parsed.error)}`, {cause: parsed.error});
	}

	const directory = parsed.data.storage?.directory;

	return directory === undefined ? null : resolve(path.dirname(configPath), directory);
};

/**
 * Discovers the roots that can contain CodeIndex-managed artifacts.
 *
 * XDG data/cache locations are inspected in addition to the historical
 * home-relative defaults, so a process started with XDG overrides does not hide
 * artifacts written by another process. Repository configuration contributes a
 * configured storage directory; OpenCode session storage is never added.
 *
 * @param input - Home, repository, environment, and optional temporary directory.
 * @returns Deduplicated absolute roots for the audit.
 */
export const discoverStorageAuditRoots = (
	input: Readonly<{home: string; repository: string; environment?: NodeJS.ProcessEnv; temporaryDirectory?: string}>,
): StorageAuditRootsType => {
	const environment = input.environment ?? {};
	const home = canonicalPath(input.home);
	const repository = canonicalPath(input.repository);
	const dataHome = environment['XDG_DATA_HOME'] === undefined ? join(home, '.local', 'share') : canonicalPath(environment['XDG_DATA_HOME']);
	const cacheHome = environment['XDG_CACHE_HOME'] === undefined ? join(home, '.cache') : canonicalPath(environment['XDG_CACHE_HOME']);
	const configured = configuredStorageRoot({repository, environment});
	const temporaryDirectory = canonicalPath(input.temporaryDirectory ?? environment['TMPDIR'] ?? tmpdir());
	const evidenceOverride = environment['CODEINDEX_EVIDENCE_ROOT'];
	const evaluationOverride = environment['EVALUATION_STATE_ROOT'];

	return {
		home,
		repository,
		storageRoots: uniquePaths([join(dataHome, 'codeindex-mcp'), join(home, '.local', 'share', 'codeindex-mcp'), ...(configured === null ? [] : [configured])]),
		cacheRoots: uniquePaths([join(cacheHome, 'codeindex-benchmark'), join(home, '.cache', 'codeindex-benchmark')]),
		evidenceRoots: uniquePaths([join(home, 'codeindex-evidence'), ...(evidenceOverride === undefined ? [] : [canonicalPath(evidenceOverride)])]),
		evaluationRoots: uniquePaths([
			join(temporaryDirectory, 'codeindex-evaluation'),
			...(evaluationOverride === undefined ? [] : [canonicalPath(evaluationOverride)]),
		]),
		temporaryDirectory,
	};
};
