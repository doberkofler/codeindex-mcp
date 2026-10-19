import {existsSync} from 'node:fs';
import path from 'node:path';
import {watch, type FSWatcher} from 'chokidar';
import {toRepositoryPath} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';

const {basename, dirname, resolve} = path;
const debug = debugFor('watch');

export type WorkspaceWatcherOptionsType = Readonly<{
	rootDir: string;
	logger: LoggerType;
	/** File extensions the selected extractor publishes. */
	sourceExtensions: readonly string[];
	/** Directory segments the selected extractor ignores. */
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

/**
 * Watches indexed directories and extractor configuration files.
 *
 * Events are hints only: the coordinator always runs a deterministic scan.
 * Directories are watched non-recursively; newly created directories are picked
 * up by reconciliation. Chokidar normalizes platform events, atomic editor
 * writes, and file creation or removal. Watcher errors request a project-wide
 * invalidation.
 */
export class WorkspaceWatcher {
	readonly #rootDir: string;
	readonly #logger: LoggerType;
	#sourceExtensions: readonly string[];
	readonly #ignoredSegments: readonly string[];
	readonly #onChange: (paths: readonly string[] | null) => void;
	readonly #watchers = new Map<string, FSWatcher>();
	#configFiles = new Set<string>();
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

		this.#configFiles = new Set(configFiles.filter((file) => existsSync(file)));
		const directories = new Set<string>([...this.#configFiles].map((file) => dirname(file)));

		for (const file of files) {
			directories.add(dirname(file.absolutePath));
		}

		for (const directory of directories) {
			if (this.#watchers.has(directory) || !existsSync(directory)) {
				continue;
			}

			this.#watchDirectory(directory);
		}

		for (const [directory, watcher] of this.#watchers) {
			if (!directories.has(directory)) {
				void watcher.close();
				this.#watchers.delete(directory);
			}
		}

		debug('watch set updated', {directories: this.#watchers.size, configFiles: this.#configFiles.size, files: files.length});
	}

	public close(): void {
		this.#started = false;

		for (const watcher of this.#watchers.values()) {
			void watcher.close();
		}

		this.#watchers.clear();
	}

	#watchDirectory(directory: string): void {
		try {
			const watcher = watch(directory, {
				persistent: true,
				ignoreInitial: true,
				depth: 0,
				ignored: (candidate): boolean => isIgnoredAbsolutePath(this.#rootDir, this.#ignoredSegments, candidate),
			});
			watcher.on('all', (event, changedPath) => {
				this.#handleEvent(event, changedPath);
			});
			watcher.on('error', (error) => {
				this.#logger.warn('watcher_error', {message: error instanceof Error ? error.message : String(error)});
				this.#onChange(null);
			});
			this.#watchers.set(directory, watcher);
		} catch (error) {
			this.#logger.warn('watcher_unavailable', {message: error instanceof Error ? error.message : String(error)});
			this.#onChange(null);
		}
	}

	#handleEvent(event: string, changedPath: string): void {
		if (!isFileEvent(event)) {
			return;
		}

		if (changedPath === '') {
			this.#onChange(null);
			return;
		}

		const absolutePath = resolve(changedPath);

		if (this.#configFiles.has(absolutePath)) {
			debug('config changed', {file: basename(absolutePath)});
			this.#onChange(null);
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
