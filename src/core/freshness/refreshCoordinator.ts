import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildOutcomeType, type QueryFreshnessType, type RefreshStateType} from '../model.ts';

const debug = debugFor('refresh');

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_SUPERSEDED_BACKOFF_MAX_MS = 30_000;
const DEFAULT_FAILED_RETRY_MAX_MS = 300_000;

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
	runRefresh: (reason: RefreshReasonType) => Promise<BuildOutcomeType>;
	logger: LoggerType;
	clock?: ClockType;
	debounceMs?: number;
	/**
	 * Optional safety interval for a full reconciliation scan.
	 *
	 * Disabled by default: a healthy watcher is the change detector, and rescans
	 * on a timer burn CPU on an idle workspace without detecting anything new.
	 * Set it only for platforms or filesystems where filesystem events are known
	 * to be unreliable. The interval is measured from the end of the previous
	 * refresh, so a slow scan cannot delay the next one.
	 */
	reconcileIntervalMs?: number;
	/** Upper bound for exponential retry after repeated superseded attempts. */
	supersededBackoffMaxMs?: number;
	/** Upper bound for retrying a failed refresh with no new event. */
	failedRetryMaxMs?: number;
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
	readonly #runRefresh: (reason: RefreshReasonType) => Promise<BuildOutcomeType>;
	readonly #logger: LoggerType;
	readonly #clock: ClockType;
	readonly #debounceMs: number;
	readonly #reconcileIntervalMs: number;
	readonly #supersededBackoffMaxMs: number;
	readonly #failedRetryMaxMs: number;
	readonly #record: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	#state: RefreshStateType = 'unknown';
	readonly #dirtyPaths = new Set<string>();
	#projectWideInvalidation = false;
	#refreshAgain = false;
	#running: Promise<void> | null = null;
	#debounceTimer: ReturnType<typeof setTimeout> | null = null;
	#reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	#failureRetryTimer: ReturnType<typeof setTimeout> | null = null;
	#failureAttempts = 0;
	#checkedAt = new Date().toISOString();
	#lastRefreshStartedAt: string | null = null;
	#lastRefreshCompletedAt: string | null = null;
	#lastError: string | null = null;
	#lastReason: RefreshReasonType | null = null;
	#firstEventAt: number | null = null;
	#supersededAttempts = 0;
	#supersededBackoffMs = 0;

	public constructor(options: RefreshCoordinatorOptionsType) {
		this.#runRefresh = options.runRefresh;
		this.#logger = options.logger;
		this.#clock = options.clock ?? systemClock;
		this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.#reconcileIntervalMs = options.reconcileIntervalMs ?? 0;
		this.#supersededBackoffMaxMs = options.supersededBackoffMaxMs ?? DEFAULT_SUPERSEDED_BACKOFF_MAX_MS;
		this.#failedRetryMaxMs = options.failedRetryMaxMs ?? DEFAULT_FAILED_RETRY_MAX_MS;
		this.#record = options.record ?? noRecord;
	}

	public start(): void {
		if (this.#state === 'stopping') {
			return;
		}

		debug('coordinator start');
		this.#armReconcile();
		this.#firstEventAt ??= this.#clock.now();
		this.#schedule('startup');
	}

	public notify(paths: readonly string[] | null): void {
		if (this.#state === 'stopping') {
			return;
		}

		this.#checkedAt = new Date().toISOString();
		this.#firstEventAt ??= this.#clock.now();

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
		this.#firstEventAt ??= this.#clock.now();
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
		this.#firstEventAt = null;
		this.#supersededAttempts = 0;
		this.#supersededBackoffMs = 0;
		this.#failureAttempts = 0;
		this.#clearFailureRetry();
		this.#lastRefreshCompletedAt = new Date(this.#clock.now()).toISOString();
	}

	/**
	 * Records a superseded attempt observed outside the coordinator.
	 *
	 * A manual `ensureReady` call runs its own refresh. When that refresh is
	 * superseded, this schedules the same single capped-backoff follow-up a
	 * watcher-triggered refresh receives. Calls made while the coordinator is
	 * already building or dirty are no-ops, so the outcome is only handled once.
	 *
	 * @param durationMs - Measured duration of the superseded attempt.
	 */
	public noteSuperseded(durationMs: number): void {
		if (this.#state === 'stopping' || this.#state === 'building' || this.#state === 'dirty') {
			return;
		}

		this.#supersededAttempts += 1;
		const backoffMs = Math.min(this.#debounceMs * 2 ** (this.#supersededAttempts - 1), this.#supersededBackoffMaxMs);
		this.#state = 'dirty';
		this.#lastError = null;
		this.#refreshAgain = false;
		this.#supersededBackoffMs = backoffMs;
		this.#record('refresh_superseded', {
			reason: 'manual',
			durationMs,
			attempt: this.#supersededAttempts,
			backoffMs,
			dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size,
		});
		this.#schedule('change', backoffMs);
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
		this.#clearReconcile();
		this.#clearFailureRetry();

		if (this.#running !== null) {
			try {
				await this.#running;
			} catch {
				// The refresh failure is already recorded.
			}
		}
	}

	#schedule(reason: RefreshReasonType, delayMs = this.#debounceMs): void {
		this.#clearDebounce();
		const effectiveDelay = this.#supersededBackoffMs > 0 ? Math.max(delayMs, this.#supersededBackoffMs) : delayMs;
		this.#debounceTimer = this.#clock.setTimeout(() => {
			this.#debounceTimer = null;
			void this.#run(reason);
		}, effectiveDelay);
		this.#debounceTimer.unref();
	}

	#clearDebounce(): void {
		if (this.#debounceTimer !== null) {
			this.#clock.clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}
	}

	/**
	 * Arms the optional safety reconciliation from now.
	 *
	 * One-shot by design: the next timer starts only after a refresh finishes, so
	 * a scan that takes longer than the interval cannot queue overlapping checks.
	 */
	#armReconcile(): void {
		this.#clearReconcile();

		if (this.#reconcileIntervalMs <= 0 || this.#state === 'stopping') {
			return;
		}

		this.#reconcileTimer = this.#clock.setTimeout(() => {
			this.#reconcileTimer = null;
			this.requestReconcile();
		}, this.#reconcileIntervalMs);
		this.#reconcileTimer.unref();
	}

	#armFailureRetry(): void {
		this.#clearFailureRetry();

		if (this.#state === 'stopping') {
			return;
		}

		this.#failureAttempts += 1;
		const delayMs = Math.min(this.#debounceMs * 2 ** (this.#failureAttempts - 1), this.#failedRetryMaxMs);
		this.#failureRetryTimer = this.#clock.setTimeout(() => {
			this.#failureRetryTimer = null;

			if (this.#state === 'stopping' || this.#state === 'building' || this.#state === 'dirty') {
				return;
			}

			// The backoff already absorbed the debounce window, so the retry runs
			// immediately instead of waiting a second time.
			this.#checkedAt = new Date().toISOString();
			this.#firstEventAt ??= this.#clock.now();
			this.#state = 'dirty';
			this.#record('watcher_reconcile');
			void this.#run('reconcile');
		}, delayMs);
		this.#failureRetryTimer.unref();
	}

	#clearFailureRetry(): void {
		if (this.#failureRetryTimer !== null) {
			this.#clock.clearTimeout(this.#failureRetryTimer);
			this.#failureRetryTimer = null;
		}
	}

	#clearReconcile(): void {
		if (this.#reconcileTimer !== null) {
			this.#clock.clearTimeout(this.#reconcileTimer);
			this.#reconcileTimer = null;
		}
	}

	async #run(reason: RefreshReasonType): Promise<void> {
		if (this.#state === 'stopping' || this.#running !== null) {
			return;
		}

		this.#refreshAgain = false;
		this.#supersededBackoffMs = 0;
		this.#clearFailureRetry();
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

	#completeSuperseded(startedAt: number, completedAt: number): void {
		this.#supersededAttempts += 1;
		const backoffMs = Math.min(this.#debounceMs * 2 ** (this.#supersededAttempts - 1), this.#supersededBackoffMaxMs);
		this.#lastRefreshCompletedAt = new Date(completedAt).toISOString();
		this.#lastError = null;
		this.#refreshAgain = false;
		this.#state = 'dirty';
		this.#supersededBackoffMs = backoffMs;
		this.#record('refresh_superseded', {
			reason: this.#lastReason,
			durationMs: Math.round(completedAt - startedAt),
			attempt: this.#supersededAttempts,
			backoffMs,
			dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size,
		});
		// A superseded candidate is discarded, not failed. Exactly one follow-up
		// runs, delayed by a capped exponential backoff so sustained churn cannot
		// spin the builder.
		this.#schedule('change', backoffMs);
	}

	#completePublished(startedAt: number, completedAt: number): void {
		this.#supersededAttempts = 0;
		this.#supersededBackoffMs = 0;
		this.#failureAttempts = 0;
		this.#clearFailureRetry();
		this.#lastRefreshCompletedAt = new Date(completedAt).toISOString();
		this.#lastError = null;
		this.#record('refresh_published', {
			reason: this.#lastReason,
			durationMs: Math.round(completedAt - startedAt),
			eventToPublicationMs: Math.round(completedAt - (this.#firstEventAt ?? startedAt)),
			dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size,
		});

		if (this.#refreshAgain) {
			this.#state = 'dirty';
			this.#refreshAgain = false;
			this.#schedule('change');
			return;
		}

		this.#state = 'current';
		this.#firstEventAt = null;
		this.#dirtyPaths.clear();
		this.#projectWideInvalidation = false;
	}

	async #execute(startedAt: number): Promise<void> {
		try {
			const outcome = await this.#runRefresh(this.#lastReason ?? 'manual');
			const completedAt = this.#clock.now();

			if (outcome === 'superseded') {
				this.#completeSuperseded(startedAt, completedAt);
				return;
			}

			this.#completePublished(startedAt, completedAt);
		} catch (error) {
			this.#supersededAttempts = 0;
			this.#supersededBackoffMs = 0;
			this.#lastError = error instanceof Error ? error.message : String(error);
			const completedAt = this.#clock.now();
			const eventToPublicationMs = completedAt - (this.#firstEventAt ?? startedAt);
			const hadPendingEvents = this.#refreshAgain;
			this.#lastRefreshCompletedAt = new Date(completedAt).toISOString();
			this.#record('refresh_failed', {
				reason: this.#lastReason,
				durationMs: Math.round(completedAt - startedAt),
				eventToPublicationMs: Math.round(eventToPublicationMs),
				dirtyFileCount: this.#projectWideInvalidation ? null : this.#dirtyPaths.size,
			});
			this.#logger.error('refresh_failed', {message: this.#lastError});

			// An event that arrived during the failed build is still pending. One
			// debounced follow-up is the accepted retry; without it the index would
			// stay stale until an unrelated edit arrived.
			if (hadPendingEvents) {
				this.#refreshAgain = false;
				this.#state = 'dirty';
				this.#schedule('change');
				return;
			}

			this.#state = 'failed';
			this.#firstEventAt = null;
			// A transient failure must recover without waiting for an unrelated
			// edit: the failure itself never produces a filesystem event. The retry
			// is bounded and backs off, so a permanently broken workspace costs a
			// scan per backoff instead of spinning.
			this.#armFailureRetry();
		} finally {
			// The safety interval restarts from completion, never from start, so a
			// slow scan cannot shorten the gap between scans.
			this.#armReconcile();
		}
	}
}
