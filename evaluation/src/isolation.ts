import {mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

/** Where an execution's OpenCode client state lives. */
export type ClientStoreModeType = 'ephemeral' | 'campaign-local';

/**
 * How the evaluated subject is isolated from the operator's checkout.
 *
 * `detached-worktree` requires a version-control client and pins a revision.
 * `disposable-copy` is the fallback when no VCS is available and pins a content
 * manifest instead.
 */
export type IsolationModeType = 'detached-worktree' | 'disposable-copy';

/** Resolved client store for one campaign. */
export type ClientStoreType = Readonly<{
	mode: ClientStoreModeType;
	/** Absolute SQLite path, or null for an in-memory store. */
	path: string | null;
	/** Value exported as `OPENCODE_DB` to every execution. */
	opencodeDb: ':memory:' | string;
}>;

export type ClientStoreInputType = Readonly<{
	/** Operator-supplied store path, or null for the ephemeral default. */
	campaignStore: string | null;
	/** Directory that relative campaign paths resolve against. */
	campaignDir: string;
	environment?: NodeJS.ProcessEnv;
	homeDirectory?: string;
}>;

/**
 * Resolves OpenCode's normal data directory.
 *
 * OpenCode honours `XDG_DATA_HOME` and otherwise uses
 * `~/.local/share/opencode` on every supported platform. The harness never
 * writes into that directory.
 *
 * @param environment - Environment source.
 * @param homeDirectory - Home directory used when XDG_DATA_HOME is unset.
 * @returns Absolute default data directory.
 */
export const defaultDataDirectoryOf = (
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory: string = homedir(),
): string => {
	const configured = environment['XDG_DATA_HOME'];
	const base = configured !== undefined && configured.length > 0 ? configured : path.join(homeDirectory, '.local', 'share');

	return path.resolve(base, 'opencode');
};

/**
 * Rejects a store path inside OpenCode's normal data directory.
 *
 * The check is lexical and does not resolve symbolic links: the store must be
 * configured outside the data directory before it exists, so a real path may
 * not be available yet.
 *
 * @param candidate - Absolute candidate store path.
 * @param dataDirectory - Absolute OpenCode data directory.
 */
export const assertOutsideDataDirectory = (candidate: string, dataDirectory: string): void => {
	const relative = path.relative(dataDirectory, candidate);
	const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

	if (inside) {
		throw new Error(`campaign store must be outside the OpenCode data directory (${dataDirectory}): ${candidate}`);
	}
};

/**
 * Resolves the client store for a campaign.
 *
 * Every campaign uses an ephemeral store unless persistence is explicitly
 * requested. A persistent store is one campaign-local SQLite file; it is never
 * the default database.
 *
 * @param input - Optional campaign store path, campaign directory, and environment.
 * @returns The store mode, path, and `OPENCODE_DB` value.
 */
export const clientStoreOf = (input: ClientStoreInputType): ClientStoreType => {
	if (input.campaignStore === null) {
		return {mode: 'ephemeral', path: null, opencodeDb: ':memory:'};
	}

	const requested = input.campaignStore.trim();

	if (requested.length === 0) {
		throw new Error('--campaign-store requires a path');
	}

	const resolved = path.resolve(input.campaignDir, requested);

	assertOutsideDataDirectory(resolved, defaultDataDirectoryOf(input.environment ?? process.env, input.homeDirectory));

	return {mode: 'campaign-local', path: resolved, opencodeDb: resolved};
};

/**
 * Creates the parent directory of a campaign-local store.
 *
 * The database file itself is created by OpenCode, so an existing file is left
 * untouched and remains available to `--resume`.
 *
 * @param store - Resolved client store.
 */
export const prepareClientStore = (store: ClientStoreType): void => {
	if (store.path !== null) {
		mkdirSync(path.dirname(store.path), {recursive: true});
	}
};

/**
 * Manifest record for the campaign client store.
 *
 * @param store - Resolved client store.
 * @returns `{kind, path}` with `path` only for a persistent store.
 */
export const campaignStoreRecordOf = (
	store: ClientStoreType,
): Readonly<{kind: 'in-memory'} | {kind: 'campaign-local-file'; path: string}> =>
	store.path === null ? {kind: 'in-memory'} : {kind: 'campaign-local-file', path: store.path};

/**
 * Manifest record for the execution isolation mode.
 *
 * @param store - Resolved client store.
 * @param mode - Subject isolation mode.
 * @returns Isolation mode, standalone server flag, and client store mode.
 */
export const isolationRecordOf = (
	store: ClientStoreType,
	mode: IsolationModeType,
): Readonly<{mode: IsolationModeType; standalone: true; clientStore: ClientStoreModeType}> => ({
	mode,
	standalone: true,
	clientStore: store.mode,
});
