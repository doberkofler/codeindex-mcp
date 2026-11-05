import {existsSync} from 'node:fs';
import path from 'node:path';
import {watch, type FSWatcher} from 'chokidar';
import {toRepositoryPath} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';

const {basename, dirname, resolve, sep} = path;
const debug = debugFor('watch');

/**
 * One logical adapter subscription over the shared filesystem watcher.
 *
 * The watcher owns one physical subscription per directory tree. Routes only
 * describe which adapter owns a changed path, so an event for one adapter never
 * invalidates another adapter's capture.
 */
export type WatchRouteType = Readonly<{
	/** Adapter identifier, or any stable subscriber identity. */
	readonly id: string;
	/** File extensions this route publishes. */
	readonly sourceExtensions: readonly string[];
	/** Absolute authored files currently owned by this route. */
	readonly files: readonly string[];
	/** Absolute configuration files and non-source inputs that invalidate this route. */
	readonly configFiles: readonly string[];
}>;

export type WorkspaceWatcherOptionsType = Readonly<{
	rootDir: string;
	logger: LoggerType;
	/** Directory segments every configured adapter ignores. */
	ignoredSegments: readonly string[];
	routes: readonly WatchRouteType[];
	/**
	 * Reports changed workspace-relative paths and the adapters they belong to.
	 *
	 * `paths === null` means the file set changed without naming a source file.
	 * `adapterIds === null` means every adapter is invalidated, either because
	 * the event is ambiguous or because it changed shared state.
	 */
	onChange: (paths: readonly string[] | null, adapterIds: readonly string[] | null) => void;
}>;

const UNIVERSAL_IGNORED_SEGMENTS = new Set(['.git', '.svn', '.hg']);

const isIgnoredPath = (relativePath: string, ignoredSegments: readonly string[]): boolean =>
	relativePath
		.split('/')
		.map((segment) => segment.toLowerCase())
		.some((segment) => UNIVERSAL_IGNORED_SEGMENTS.has(segment) || ignoredSegments.includes(segment));

const isIgnoredAbsolutePath = (rootDir: string, ignoredSegments: readonly string[], absolutePath: string): boolean => {
	const relativePath = path.relative(rootDir, absolutePath);

	if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
		return false;
	}

	return isIgnoredPath(relativePath.split(path.sep).join('/'), ignoredSegments);
};

const isPublishable = (filePath: string, extensions: ReadonlySet<string>): boolean =>
	!filePath.endsWith('.d.ts') &&
	!filePath.endsWith('.d.mts') &&
	!filePath.endsWith('.d.cts') &&
	[...extensions].some((extension) => filePath.endsWith(extension));

const isFileEvent = (event: string): boolean => event === 'add' || event === 'change' || event === 'unlink';

const isDirectoryEvent = (event: string): boolean => event === 'addDir' || event === 'unlinkDir';

/**
 * Reduces directories to the smallest set that still covers all of them.
 *
 * A recursive watcher on a parent already reports changes in every descendant,
 * so subscribing to both duplicates every event. The workspace root is never
 * treated as a covering ancestor: a file directly in the root would otherwise
 * promote the whole tree, including unrelated trees, to a watch target.
 *
 * @param directories - Absolute directories that must be covered.
 * @param rootDir - Absolute workspace root.
 * @returns Sorted minimal covering directories.
 */
const coveringRoots = (directories: Iterable<string>, rootDir: string): readonly string[] => {
	const candidates = [...new Set(directories)].sort();
	const roots: string[] = [];

	for (const directory of candidates) {
		const covered = roots.some((root) => directory !== rootDir && (directory === root || directory.startsWith(`${root}${sep}`)));

		if (!covered) {
			roots.push(directory);
		}
	}

	return roots;
};

const ownersOf = (owners: ReadonlyMap<string, Set<string>>, key: string): readonly string[] | null => {
	const found = owners.get(key);
	return found === undefined || found.size === 0 ? null : [...found].sort();
};

const addOwner = (owners: Map<string, Set<string>>, key: string, id: string): void => {
	const current = owners.get(key);

	if (current === undefined) {
		owners.set(key, new Set([id]));
		return;
	}

	current.add(id);
};

/**
 * Watches indexed directories and extractor configuration files.
 *
 * One physical watcher serves every adapter. Events are routed to the adapters
 * that own the changed path, so a TypeScript edit cannot invalidate an Oracle
 * capture and the reverse. Directory events, watcher errors, and ambiguous
 * paths still invalidate every adapter.
 *
 * Events are hints. The coordinator still runs a deterministic scan, and that
 * scan remains authoritative; no timer rescans an idle workspace.
 */
export class WorkspaceWatcher {
	readonly #rootDir: string;
	readonly #logger: LoggerType;
	readonly #ignoredSegments: readonly string[];
	readonly #onChange: (paths: readonly string[] | null, adapterIds: readonly string[] | null) => void;
	readonly #watchers = new Map<string, FSWatcher>();
	#watchedFiles = new Set<string>();
	#configOwners = new Map<string, Set<string>>();
	#fileOwners = new Map<string, Set<string>>();
	#extensionOwners = new Map<string, Set<string>>();
	#sourceExtensions = new Set<string>();
	#started = false;

	public constructor(options: WorkspaceWatcherOptionsType) {
		this.#rootDir = options.rootDir;
		this.#logger = options.logger;
		this.#ignoredSegments = options.ignoredSegments;
		this.#onChange = options.onChange;
		this.update(options.routes);
	}

	public start(routes: readonly WatchRouteType[]): void {
		this.#started = true;
		this.update(routes);
	}

	public update(routes: readonly WatchRouteType[]): void {
		this.#indexRoutes(routes);

		if (!this.#started) {
			return;
		}

		const directoryRoots = coveringRoots(
			routes.flatMap((route) => route.files.map((file) => dirname(resolve(file)))),
			this.#rootDir,
		);
		const watchedFiles = new Set<string>();

		for (const route of routes) {
			for (const configFile of route.configFiles) {
				const absolutePath = resolve(configFile);

				// A configuration file inside a watched tree already produces events.
				// Watching a path that does not exist would subscribe to its parent
				// directory instead, so only existing files are watched directly.
				if (existsSync(absolutePath) && !directoryRoots.some((root) => absolutePath.startsWith(`${root}${sep}`))) {
					watchedFiles.add(absolutePath);
				}
			}
		}

		for (const root of directoryRoots) {
			if (this.#watchers.has(root)) {
				continue;
			}

			this.#watch(root, 'tree');
		}

		for (const file of watchedFiles) {
			if (this.#watchers.has(file)) {
				continue;
			}

			this.#watch(file, 'file');
		}

		const wanted = new Set([...directoryRoots, ...watchedFiles]);

		for (const [target, watcher] of this.#watchers) {
			if (!wanted.has(target)) {
				void watcher.close();
				this.#watchers.delete(target);
			}
		}

		this.#watchedFiles = watchedFiles;
		debug('watch set updated', {trees: this.#watchers.size - this.#watchedFiles.size, files: this.#watchedFiles.size});
	}

	public close(): void {
		this.#started = false;

		for (const watcher of this.#watchers.values()) {
			void watcher.close();
		}

		this.#watchers.clear();
		this.#watchedFiles.clear();
		this.#configOwners.clear();
		this.#fileOwners.clear();
		this.#extensionOwners.clear();
		this.#sourceExtensions.clear();
	}

	#indexRoutes(routes: readonly WatchRouteType[]): void {
		const configOwners = new Map<string, Set<string>>();
		const fileOwners = new Map<string, Set<string>>();
		const extensionOwners = new Map<string, Set<string>>();
		const sourceExtensions = new Set<string>();

		for (const route of routes) {
			for (const configFile of route.configFiles) {
				addOwner(configOwners, resolve(configFile), route.id);
			}

			for (const file of route.files) {
				addOwner(fileOwners, resolve(file), route.id);
			}

			for (const extension of route.sourceExtensions) {
				sourceExtensions.add(extension);
				addOwner(extensionOwners, extension, route.id);
			}
		}

		this.#configOwners = configOwners;
		this.#fileOwners = fileOwners;
		this.#extensionOwners = extensionOwners;
		this.#sourceExtensions = sourceExtensions;
	}

	#watch(target: string, kind: 'tree' | 'file'): void {
		try {
			const watcher = watch(target, {
				persistent: true,
				ignoreInitial: true,
				// Nothing is watched above the target, so the workspace ignore rules
				// are applied here; an explicitly watched configuration file is never
				// ignored, even under an excluded directory.
				ignored: kind === 'file' ? (): boolean => false : (candidate): boolean => isIgnoredAbsolutePath(this.#rootDir, this.#ignoredSegments, candidate),
			});
			watcher.on('all', (event, changedPath) => {
				this.#handleEvent(event, changedPath);
			});
			watcher.on('error', (error) => {
				this.#logger.warn('watcher_error', {message: error instanceof Error ? error.message : String(error)});
				this.#onChange(null, null);
			});
			this.#watchers.set(target, watcher);
		} catch (error) {
			this.#logger.warn('watcher_unavailable', {message: error instanceof Error ? error.message : String(error)});
			this.#onChange(null, null);
		}
	}

	#handleEvent(event: string, changedPath: string): void {
		if (changedPath === '') {
			this.#onChange(null, null);
			return;
		}

		const absolutePath = resolve(changedPath);
		const configAdapters = ownersOf(this.#configOwners, absolutePath);

		if (configAdapters !== null) {
			debug('adapter input changed', {file: basename(absolutePath), adapters: configAdapters});
			this.#onChange(null, configAdapters);
			return;
		}

		if (isDirectoryEvent(event)) {
			// A new directory can contain files that already existed elsewhere in the
			// tree, and a removed directory can take indexed files with it. Neither
			// names a source file, so the file set must be rescanned.
			if (!isIgnoredAbsolutePath(this.#rootDir, this.#ignoredSegments, absolutePath)) {
				debug('directory changed', {event});
				this.#onChange(null, null);
			}

			return;
		}

		if (!isFileEvent(event)) {
			return;
		}

		const ownedAdapters = ownersOf(this.#fileOwners, absolutePath);
		const extensionAdapters = this.#adaptersForExtensions(absolutePath);

		if (ownedAdapters === null && extensionAdapters === null) {
			return;
		}

		let relativePath: string;

		try {
			relativePath = toRepositoryPath(this.#rootDir, absolutePath);
		} catch {
			return;
		}

		if (isIgnoredPath(relativePath, this.#ignoredSegments)) {
			return;
		}

		this.#onChange([relativePath], ownedAdapters ?? extensionAdapters);
	}

	#adaptersForExtensions(filePath: string): readonly string[] | null {
		if (!isPublishable(filePath, this.#sourceExtensions)) {
			return null;
		}

		const owners = new Set<string>();

		for (const [extension, adapterIds] of this.#extensionOwners) {
			if (filePath.endsWith(extension)) {
				for (const adapterId of adapterIds) {
					owners.add(adapterId);
				}
			}
		}

		return owners.size === 0 ? null : [...owners].sort();
	}
}
