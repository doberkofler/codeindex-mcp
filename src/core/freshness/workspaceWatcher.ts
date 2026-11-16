import path from 'node:path';

import {type AdapterWatchPlanType, type AdapterWatchRuleType} from '@codeindex/adapter-sdk';
import {watch, type FSWatcher} from 'chokidar';

import {toRepositoryPath} from '../config/config.ts';
import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';

const {resolve, sep} = path;
const debug = debugFor('watch');

export type RoutedWatchEventType = Readonly<{
	readonly paths: readonly string[] | null;
	readonly adapterIds: readonly string[];
}>;

export type WorkspaceWatcherOptionsType = Readonly<{
	rootDir: string;
	logger: LoggerType;
	plans: readonly AdapterWatchPlanType[];
	/**
	 * Reports changed workspace-relative paths and the adapters they belong to.
	 *
	 * `paths === null` means an adapter-wide invalidation. The watcher reports
	 * only adapter IDs selected by the current logical plans.
	 */
	onChange: (paths: readonly string[] | null, adapterIds: readonly string[]) => void;
}>;

type PhysicalWatcherType = Readonly<{
	readonly watcher: FSWatcher;
	readonly ready: Promise<true>;
	readonly settleReady: () => void;
}>;

const matchesRule = (relativePath: string, rule: AdapterWatchRuleType): boolean => {
	if (rule.kind === 'glob') {
		return path.matchesGlob(relativePath, rule.pattern);
	}

	if (rule.kind === 'prefix') {
		return rule.path === '' || relativePath === rule.path || relativePath.startsWith(`${rule.path}/`);
	}

	if (rule.kind === 'suffix') {
		return relativePath.endsWith(rule.suffix);
	}

	const segments = relativePath.split('/');
	return rule.ignoreCase === true ? segments.some((segment) => segment.toLowerCase() === rule.segment.toLowerCase()) : segments.includes(rule.segment);
};

const scopeContainsPath = (relativePath: string, roots: readonly string[]): boolean =>
	roots.some((root) => root === '' || relativePath === root || relativePath.startsWith(`${root}/`));

const scopeMatchesFile = (relativePath: string, plan: AdapterWatchPlanType): boolean =>
	plan.scopes.some(
		(scope) =>
			scopeContainsPath(relativePath, scope.candidateRoots) &&
			scope.includeRules.some((rule) => matchesRule(relativePath, rule)) &&
			!scope.excludeRules.some((rule) => matchesRule(relativePath, rule)) &&
			scope.sourceRules.some((rule) => matchesRule(relativePath, rule)),
	);

const rootsIntersectDirectory = (relativePath: string, roots: readonly string[]): boolean =>
	roots.some(
		(root) => root === '' || relativePath === '' || relativePath === root || relativePath.startsWith(`${root}/`) || root.startsWith(`${relativePath}/`),
	);

const ruleExcludesDirectoryTree = (relativePath: string, rule: AdapterWatchRuleType): boolean =>
	(rule.kind === 'prefix' || rule.kind === 'segment') && matchesRule(relativePath, rule);

const scopeIntersectsDirectory = (relativePath: string, plan: AdapterWatchPlanType): boolean =>
	plan.scopes.some(
		(scope) => rootsIntersectDirectory(relativePath, scope.candidateRoots) && !scope.excludeRules.some((rule) => ruleExcludesDirectoryTree(relativePath, rule)),
	);

const exactPathIntersectsDirectory = (relativePath: string, plan: AdapterWatchPlanType): boolean =>
	[...plan.inputFiles, ...plan.knownSourceFiles].some((exactPath) => scopeContainsPath(exactPath, [relativePath]));

const isFileEvent = (event: string): boolean => event === 'add' || event === 'change' || event === 'unlink';

const isDirectoryEvent = (event: string): boolean => event === 'addDir' || event === 'unlinkDir';

/**
 * Matches one normalized filesystem event against adapter-owned plans.
 *
 * @param plans - Current validated logical plans.
 * @param event - Chokidar event name.
 * @param relativePath - Workspace-relative POSIX path.
 * @returns Coalesced path/invalidation and affected adapters, or null.
 */
export const routeWatchEvent = (plans: readonly AdapterWatchPlanType[], event: string, relativePath: string): RoutedWatchEventType | null => {
	const adapterIds = new Set<string>();
	let projectWide = false;

	for (const plan of plans) {
		if (plan.inputFiles.includes(relativePath)) {
			adapterIds.add(plan.adapterId);
			projectWide = true;
		} else if (plan.knownSourceFiles.includes(relativePath)) {
			adapterIds.add(plan.adapterId);
		} else if (
			isDirectoryEvent(event)
				? exactPathIntersectsDirectory(relativePath, plan) || scopeIntersectsDirectory(relativePath, plan)
				: isFileEvent(event)
					? scopeMatchesFile(relativePath, plan)
					: plan.scopes.some((scope) => scopeContainsPath(relativePath, scope.candidateRoots))
		) {
			adapterIds.add(plan.adapterId);
			projectWide ||= !isFileEvent(event);
		}
	}

	return adapterIds.size === 0 ? null : {paths: projectWide ? null : [relativePath], adapterIds: [...adapterIds].sort()};
};

/**
 * Attributes a watcher backend failure to plans using one physical root.
 *
 * @param plans - Current validated logical plans.
 * @param relativeRoot - Failed workspace-relative root, or null for an unscoped backend failure.
 * @returns Conservative invalidation for affected adapters.
 */
export const routeWatchFailure = (plans: readonly AdapterWatchPlanType[], relativeRoot: string | null): RoutedWatchEventType => {
	const adapterIds =
		relativeRoot === null
			? plans.map((plan) => plan.adapterId)
			: plans
					.filter(
						(plan) =>
							exactPathIntersectsDirectory(relativeRoot, plan) || plan.scopes.some((scope) => rootsIntersectDirectory(relativeRoot, scope.candidateRoots)),
					)
					.map((plan) => plan.adapterId);

	return {paths: null, adapterIds: [...new Set(adapterIds)].sort()};
};

/**
 * Reduces directories to the smallest recursively covering physical set.
 *
 * @param directories - Absolute candidate roots.
 * @returns Sorted minimal covering directories.
 */
const coveringRoots = (directories: Iterable<string>): readonly string[] => {
	const candidates = [...new Set(directories)].sort((left, right) => left.length - right.length || left.localeCompare(right));
	const roots: string[] = [];

	for (const directory of candidates) {
		if (!roots.some((root) => directory === root || directory.startsWith(`${root}${sep}`))) {
			roots.push(directory);
		}
	}

	return roots.sort();
};

/**
 * Watches physical roots once and routes hints through adapter-owned plans.
 *
 * Filesystem events remain hints. A routed refresh still performs an
 * authoritative adapter scan before publication.
 */
export class WorkspaceWatcher {
	readonly #rootDir: string;
	readonly #logger: LoggerType;
	readonly #onChange: WorkspaceWatcherOptionsType['onChange'];
	readonly #watchers = new Map<string, PhysicalWatcherType>();
	#watchedFiles = new Set<string>();
	#plans: readonly AdapterWatchPlanType[];
	#started = false;

	public constructor(options: WorkspaceWatcherOptionsType) {
		this.#rootDir = resolve(options.rootDir);
		this.#logger = options.logger;
		this.#plans = options.plans;
		this.#onChange = options.onChange;
	}

	public async start(plans: readonly AdapterWatchPlanType[]): Promise<void> {
		this.#started = true;
		await this.update(plans);
	}

	public async update(plans: readonly AdapterWatchPlanType[]): Promise<void> {
		this.#plans = plans;

		if (!this.#started) {
			return;
		}

		const directoryRoots = coveringRoots(
			plans.flatMap((plan) => plan.scopes.flatMap((scope) => scope.candidateRoots.map((root) => resolve(this.#rootDir, root)))),
		);
		const watchedFiles = new Set<string>();
		const exactPaths = plans.flatMap((plan) => [...plan.knownSourceFiles, ...plan.inputFiles]);

		for (const relativePath of exactPaths) {
			const absolutePath = resolve(this.#rootDir, relativePath);

			if (!directoryRoots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}${sep}`))) {
				watchedFiles.add(absolutePath);
			}
		}

		for (const root of directoryRoots) {
			if (!this.#watchers.has(root)) {
				this.#watch(root);
			}
		}

		for (const file of watchedFiles) {
			if (!this.#watchers.has(file)) {
				this.#watch(file);
			}
		}

		const wanted = new Set([...directoryRoots, ...watchedFiles]);

		for (const [target, physical] of this.#watchers) {
			if (!wanted.has(target)) {
				physical.settleReady();
				void physical.watcher.close();
				this.#watchers.delete(target);
			}
		}

		this.#watchedFiles = watchedFiles;
		debug('watch set updated', {trees: this.#watchers.size - this.#watchedFiles.size, files: this.#watchedFiles.size});
		const readiness = [...wanted].flatMap((target) => {
			const physical = this.#watchers.get(target);
			return physical === undefined ? [] : [physical.ready];
		});
		await Promise.all(readiness);
	}

	public close(): void {
		this.#started = false;

		for (const physical of this.#watchers.values()) {
			physical.settleReady();
			void physical.watcher.close();
		}

		this.#watchers.clear();
		this.#watchedFiles.clear();
		this.#plans = [];
	}

	#watch(target: string): void {
		const readiness = Promise.withResolvers<true>();
		const settleReady = (): void => {
			readiness.resolve(true);
		};

		try {
			const watcher = watch(target, {persistent: true, ignoreInitial: true});
			watcher.once('ready', settleReady);
			watcher.on('all', (event, changedPath) => {
				this.#handleEvent(event, changedPath);
			});
			watcher.on('error', (error) => {
				settleReady();
				this.#logger.warn('watcher_error', {message: error instanceof Error ? error.message : String(error)});
				this.#reportFailure(target);
			});
			this.#watchers.set(target, {watcher, ready: readiness.promise, settleReady});
		} catch (error) {
			settleReady();
			this.#logger.warn('watcher_unavailable', {message: error instanceof Error ? error.message : String(error)});
			this.#reportFailure(target);
		}
	}

	#relativePath(absolutePath: string): string {
		const resolved = resolve(absolutePath);
		return resolved === this.#rootDir ? '' : toRepositoryPath(this.#rootDir, resolved);
	}

	#reportFailure(target: string | null): void {
		let relativeRoot: string | null = null;

		if (target !== null) {
			try {
				relativeRoot = this.#relativePath(target);
			} catch {
				relativeRoot = null;
			}
		}

		const routed = routeWatchFailure(this.#plans, relativeRoot);

		if (routed.adapterIds.length > 0) {
			this.#onChange(routed.paths, routed.adapterIds);
		}
	}

	#handleEvent(event: string, changedPath: string): void {
		if (changedPath === '') {
			this.#reportFailure(null);
			return;
		}

		let relativePath: string;

		try {
			relativePath = this.#relativePath(changedPath);
		} catch {
			return;
		}

		const routed = routeWatchEvent(this.#plans, event, relativePath);

		if (routed !== null) {
			debug('watch event routed', {event, adapters: routed.adapterIds, projectWide: routed.paths === null});
			this.#onChange(routed.paths, routed.adapterIds);
		}
	}
}
