import {existsSync} from 'node:fs';
import path from 'node:path';
import {watch, type FSWatcher} from 'chokidar';
import {toRepositoryPath} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';

const {basename, dirname, resolve, sep} = path;
const debug = debugFor('watch');

export type WorkspaceWatcherOptionsType = Readonly<{
	rootDir: string;
	logger: LoggerType;
	/** File extensions the configured adapters publish. */
	sourceExtensions: readonly string[];
	/** Directory segments every configured adapter ignores. */
	ignoredSegments: readonly string[];
	onChange: (paths: readonly string[] | null) => void;
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

const isPublishable = (filePath: string, extensions: readonly string[]): boolean =>
	!filePath.endsWith('.d.ts') && !filePath.endsWith('.d.mts') && !filePath.endsWith('.d.cts') && extensions.some((extension) => filePath.endsWith(extension));

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

/**
 * Watches indexed directories and extractor configuration files.
 *
 * Watching is recursive where it can be: Chokidar reports nested file changes,
 * newly created directories, and removed directory trees with native filesystem
 * events. Directory events request a project-wide scan because a new or removed
 * directory can change the indexed file set without naming a source file.
 *
 * Events are hints. The coordinator still runs a deterministic scan, and that
 * scan remains authoritative; no timer rescans an idle workspace.
 */
export class WorkspaceWatcher {
	readonly #rootDir: string;
	readonly #logger: LoggerType;
	#sourceExtensions: readonly string[];
	readonly #ignoredSegments: readonly string[];
	readonly #onChange: (paths: readonly string[] | null) => void;
	readonly #watchers = new Map<string, FSWatcher>();
	#watchedFiles = new Set<string>();
	#started = false;

	public constructor(options: WorkspaceWatcherOptionsType) {
		this.#rootDir = options.rootDir;
		this.#logger = options.logger;
		this.#sourceExtensions = options.sourceExtensions;
		this.#ignoredSegments = options.ignoredSegments;
		this.#onChange = options.onChange;
	}

	public start(files: readonly Readonly<{absolutePath: string}>[], configFiles: readonly string[]): void {
		this.#started = true;
		this.update(files, configFiles);
	}

	public update(files: readonly Readonly<{absolutePath: string}>[], configFiles: readonly string[], sourceExtensions?: readonly string[]): void {
		if (!this.#started) {
			return;
		}

		if (sourceExtensions !== undefined) {
			this.#sourceExtensions = sourceExtensions;
		}

		const directoryRoots = coveringRoots(
			files.map((file) => dirname(file.absolutePath)),
			this.#rootDir,
		);
		const watchedFiles = new Set<string>();

		for (const configFile of configFiles) {
			const absolutePath = resolve(configFile);

			// A configuration file inside a watched tree already produces events.
			// Watching a path that does not exist would subscribe to its parent
			// directory instead, so only existing files are watched directly.
			if (existsSync(absolutePath) && !directoryRoots.some((root) => absolutePath.startsWith(`${root}${sep}`))) {
				watchedFiles.add(absolutePath);
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
		debug('watch set updated', {trees: this.#watchers.size - this.#watchedFiles.size, files: this.#watchedFiles.size, knownFiles: files.length});
	}

	public close(): void {
		this.#started = false;

		for (const watcher of this.#watchers.values()) {
			void watcher.close();
		}

		this.#watchers.clear();
		this.#watchedFiles.clear();
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
				this.#onChange(null);
			});
			this.#watchers.set(target, watcher);
		} catch (error) {
			this.#logger.warn('watcher_unavailable', {message: error instanceof Error ? error.message : String(error)});
			this.#onChange(null);
		}
	}

	#handleEvent(event: string, changedPath: string): void {
		if (changedPath === '') {
			this.#onChange(null);
			return;
		}

		const absolutePath = resolve(changedPath);

		if (this.#watchedFiles.has(absolutePath)) {
			debug('config changed', {file: basename(absolutePath)});
			this.#onChange(null);
			return;
		}

		if (isDirectoryEvent(event)) {
			// A new directory can contain files that already existed elsewhere in the
			// tree, and a removed directory can take indexed files with it. Neither
			// names a source file, so the file set must be rescanned.
			if (!isIgnoredAbsolutePath(this.#rootDir, this.#ignoredSegments, absolutePath)) {
				debug('directory changed', {event});
				this.#onChange(null);
			}

			return;
		}

		if (!isFileEvent(event)) {
			return;
		}

		if (!isPublishable(absolutePath, this.#sourceExtensions)) {
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

		this.#onChange([relativePath]);
	}
}
