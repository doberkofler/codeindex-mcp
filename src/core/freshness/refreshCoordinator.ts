import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type QueryFreshnessType, type RefreshStateType} from '../model.ts';

const debug = debugFor('refresh');

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

export type ClockType = Readonly<{
	now: () => number;
	setTimeout: (action: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
	setInterval: (action: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}>;

const systemClock: ClockType = {
	now: () => Date.now(),
	setTimeout: (action, delayMs) => setTimeout(action, delayMs),
	clearTimeout: (handle) => {
		clearTimeout(handle);
	},
	setInterval: (action, delayMs) => setInterval(action, delayMs),
	clearInterval: (handle) => {
		clearInterval(handle);
	},
};

export type RefreshReasonType = 'startup' | 'change' | 'reconcile' | 'manual';

export type RefreshCoordinatorSnapshotType = Readonly<{
	readonly state: RefreshStateType;
	readonly checkedAt: string;
	readonly dirtyFileCount: number | null;
	readonly projectWideInvalidation: boolean;
	readonly refreshAgain: boolean;
	readonly lastRefreshStartedAt: string | null;
	readonly lastRefreshCompletedAt: string | null;
	readonly lastError: string | null;
	readonly lastReason: RefreshReasonType | null;
}>;

export type RefreshCoordinatorOptionsType = Readonly<{
	runRefresh: (reason: RefreshReasonType) => Promise<void>;
	logger: LoggerType;
	clock?: ClockType;
	debounceMs?: number;
	reconcileIntervalMs?: number;
	record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

const noRecord = (_event: string, _fields?: Readonly<Record<string, unknown>>): void => {
	// Analytics are optional; the coordinator stays usable without a recorder.
};

/**
 * Owns refresh scheduling and freshness state.
 *
 * Filesystem events are hints. The coordinator coalesces bursts, permits exactly
 * one running refresh, and converts events during a refresh into exactly one
 * follow-up. It performs no indexing work itself.
 */
export class RefreshCoordinator {
	readonly #runRefresh: (reason: RefreshReasonType) => Promise<void>;
	readonly #logger: LoggerType;
	readonly #clock: ClockType;
	readonly #debounceMs: number;
	readonly #reconcileIntervalMs: number;
	readonly #record: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	#state: RefreshStateType = 'unknown';
	readonly #dirtyPaths = new Set<string>();
	#projectWideInvalidation = false;
	#refreshAgain = false;
	#running: Promise<void> | null = null;
	#debounceTimer: ReturnType<typeof setTimeout> | null = null;
	#reconcileTimer: ReturnType<typeof setInterval> | null = null;
	#checkedAt = new Date().toISOString();
	#lastRefreshStartedAt: string | null = null;
	#lastRefreshCompletedAt: string | null = null;
	#lastError: string | null = null;
	#lastReason: RefreshReasonType | null = null;

	public constructor(options: RefreshCoordinatorOptionsType) {
		this.#runRefresh = options.runRefresh;
		this.#logger = options.logger;
		this.#clock = options.clock ?? systemClock;
		this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.#reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		this.#record = options.record ?? noRecord;
	}

	public start(): void {
		if (this.#state === 'stopping') {
			return;
		}

		debug('coordinator start');
		this.#reconcileTimer = this.#clock.setInterval(() => {
			this.requestReconcile();
		}, this.#reconcileIntervalMs);
		this.#reconcileTimer.unref();
		this.#schedule('startup');
	}

	public notify(paths: readonly string[] | null): void {
		if (this.#state === 'stopping') {
			return;
		}

		this.#checkedAt = new Date().toISOString();

		if (paths === null) {
			this.#projectWideInvalidation = true;
			this.#dirtyPaths.clear();
		} else {
			for (const path of paths) {
				this.#dirtyPaths.add(path);
			}
		}

		this.#record('watcher_event', {
			projectWide: paths === null,
			pathCount: paths === null ? null : paths.length,
		});

		if (this.#state === 'building' || this.#running !== null) {
			this.#refreshAgain = true;
			this.#record('refresh_coalesced');
			debug('event during build coalesced');
			return;
		}

		this.#state = 'dirty';
		this.#schedule('change');
	}

	/**
	 * Requests a deterministic reconciliation scan.
	 *
	 * Reconciliation is skipped while a refresh is pending or running.
	 */
	public requestReconcile(): void {
		if (this.#state === 'stopping' || this.#state === 'building' || this.#state === 'dirty' || this.#running !== null) {
			return;
		}

		this.#checkedAt = new Date().toISOString();
		this.#state = 'dirty';
		this.#record('watcher_reconcile');
		this.#schedule('reconcile');
	}

	/**
	 * Forces one refresh through the same single-build path.
	 *
	 * @param reason - Recorded reason for the refresh.
	 * @returns Completion when the refresh finishes.
	 */
	public async refreshNow(reason: RefreshReasonType = 'manual'): Promise<void> {
		this.#clearDebounce();
		await this.#run(reason);
	}

	public markCurrent(): void {
		if (this.#state === 'stopping') {
			return;
		}

		this.#state = 'current';
		this.#dirtyPaths.clear();
		this.#projectWideInvalidation = false;
		this.#refreshAgain = false;
		this.#lastRefreshCompletedAt = new Date(this.#clock.now()).toISOString();
	}

	public getSnapshot(): RefreshCoordinatorSnapshotType {
		return {
			state: this.#state,
			checkedAt: this.#checkedAt,
			dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size,
			projectWideInvalidation: this.#projectWideInvalidation,
			refreshAgain: this.#refreshAgain,
			lastRefreshStartedAt: this.#lastRefreshStartedAt,
			lastRefreshCompletedAt: this.#lastRefreshCompletedAt,
			lastError: this.#lastError,
			lastReason: this.#lastReason,
		};
	}

	public getFreshness(): QueryFreshnessType {
		const snapshot = this.getSnapshot();
		const state =
			snapshot.state === 'current'
				? 'current'
				: snapshot.state === 'dirty' || snapshot.state === 'building'
					? 'updating'
					: snapshot.state === 'failed'
						? 'stale'
						: 'unknown';

		return {state, checkedAt: snapshot.checkedAt, dirtyFileCount: snapshot.dirtyFileCount};
	}

	public isPathDirty(filePath: string): boolean {
		return this.#projectWideInvalidation || this.#dirtyPaths.has(filePath);
	}

	public async close(): Promise<void> {
		this.#state = 'stopping';
		this.#clearDebounce();

		if (this.#reconcileTimer !== null) {
			this.#clock.clearInterval(this.#reconcileTimer);
			this.#reconcileTimer = null;
		}

		if (this.#running !== null) {
			try {
				await this.#running;
			} catch {
				// The refresh failure is already recorded.
			}
		}
	}

	#schedule(reason: RefreshReasonType): void {
		this.#clearDebounce();
		this.#debounceTimer = this.#clock.setTimeout(() => {
			this.#debounceTimer = null;
			void this.#run(reason);
		}, this.#debounceMs);
		this.#debounceTimer.unref();
	}

	#clearDebounce(): void {
		if (this.#debounceTimer !== null) {
			this.#clock.clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}
	}

	async #run(reason: RefreshReasonType): Promise<void> {
		if (this.#state === 'stopping' || this.#running !== null) {
			return;
		}

		this.#refreshAgain = false;
		this.#state = 'building';
		this.#lastReason = reason;
		this.#lastRefreshStartedAt = new Date(this.#clock.now()).toISOString();
		const startedAt = this.#clock.now();
		this.#record('refresh_started', {reason, dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size});
		debug('refresh run', {reason, dirtyPaths: this.#dirtyPaths.size, projectWide: this.#projectWideInvalidation});
		this.#running = this.#execute(startedAt);

		try {
			await this.#running;
		} finally {
			this.#running = null;
		}
	}

	async #execute(startedAt: number): Promise<void> {
		try {
			await this.#runRefresh(this.#lastReason ?? 'manual');
			this.#lastRefreshCompletedAt = new Date(this.#clock.now()).toISOString();
			this.#lastError = null;
			this.#record('refresh_published', {
				reason: this.#lastReason,
				durationMs: Math.round(this.#clock.now() - startedAt),
				dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size,
			});

			if (this.#refreshAgain) {
				this.#state = 'dirty';
				this.#refreshAgain = false;
				this.#schedule('change');
				return;
			}

			this.#state = 'current';
			this.#dirtyPaths.clear();
			this.#projectWideInvalidation = false;
		} catch (error) {
			this.#lastError = error instanceof Error ? error.message : String(error);
			this.#lastRefreshCompletedAt = new Date(this.#clock.now()).toISOString();
			this.#state = 'failed';
			this.#record('refresh_failed', {
				reason: this.#lastReason,
				durationMs: Math.round(this.#clock.now() - startedAt),
				dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size,
			});
			this.#logger.error('refresh_failed', {message: this.#lastError});
		}
	}
}
