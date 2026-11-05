import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildOutcomeType, type QueryFreshnessType, type RefreshStateType} from '../model.ts';
import {systemClock, type ClockType} from './refreshClock.ts';
import {adapterScopeIsAffected, dirtyFileCountOf, isFullScope, projectWideInvalidationOf, scopeFor, type RefreshAdapterScopeType} from './refreshScope.ts';
import {RefreshTimers} from './refreshTimers.ts';
import {
	DEFAULT_DEBOUNCE_MS,
	DEFAULT_FAILED_RETRY_MAX_MS,
	DEFAULT_SUPERSEDED_BACKOFF_MAX_MS,
	freshnessOf,
	noRecord,
	type RefreshCoordinatorOptionsType,
	type RefreshCoordinatorSnapshotType,
	type RefreshReasonType,
} from './refreshTypes.ts';

export {type ClockType} from './refreshClock.ts';
export {type RefreshAdapterScopeType} from './refreshScope.ts';
export {type RefreshCoordinatorOptionsType, type RefreshCoordinatorSnapshotType, type RefreshReasonType} from './refreshTypes.ts';

const debug = debugFor('refresh');

/**
 * Owns refresh scheduling and freshness state.
 *
 * Filesystem events are hints. The coordinator coalesces bursts, permits exactly
 * one running refresh, and converts events during a refresh into exactly one
 * follow-up. It performs no indexing work itself.
 *
 * Adapter scope is tracked separately from filesystem churn: an event that
 * belongs to another adapter is queued as follow-up work but does not abort the
 * running attempt. An event that belongs to the captured adapter scope confirms
 * the attempt is obsolete and signals cooperative cancellation.
 */
export class RefreshCoordinator {
	readonly #runRefresh: (reason: RefreshReasonType, adapterIds: RefreshAdapterScopeType, signal: AbortSignal) => Promise<BuildOutcomeType>;
	readonly #logger: LoggerType;
	readonly #clock: ClockType;
	readonly #debounceMs: number;
	readonly #reconcileIntervalMs: number;
	readonly #supersededBackoffMaxMs: number;
	readonly #failedRetryMaxMs: number;
	readonly #record: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	#state: RefreshStateType = 'unknown';
	/** Paths captured by the running attempt. */
	readonly #activeDirtyPaths = new Set<string>();
	/** Paths received after the running attempt captured its scope. */
	readonly #dirtyPaths = new Set<string>();
	#activeProjectWideInvalidation = false;
	#projectWideInvalidation = false;
	readonly #dirtyAdapters = new Set<string>();
	#activeAdapterIds: RefreshAdapterScopeType = null;
	#allAdaptersDirty = false;
	#refreshAgain = false;
	#running: Promise<void> | null = null;
	#abort: AbortController | null = null;
	readonly #timers: RefreshTimers;
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
		this.#timers = new RefreshTimers(this.#clock);
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

	/**
	 * Records one filesystem observation.
	 *
	 * @param paths - Changed workspace-relative paths, or null when the file set changed.
	 * @param adapterIds - Adapters that own the change, or null for every adapter.
	 * @returns Nothing.
	 */
	public notify(paths: readonly string[] | null, adapterIds: RefreshAdapterScopeType = null): void {
		if (this.#state === 'stopping') {
			return;
		}

		this.#checkedAt = new Date().toISOString();
		this.#firstEventAt ??= this.#clock.now();
		const fullScope = paths === null || isFullScope(adapterIds) || adapterIds.length === 0;

		if (fullScope) {
			this.#projectWideInvalidation = true;
			this.#dirtyPaths.clear();
			this.#allAdaptersDirty = true;
			this.#dirtyAdapters.clear();
		} else {
			for (const changedPath of paths) {
				this.#dirtyPaths.add(changedPath);
			}

			for (const adapterId of adapterIds) {
				this.#dirtyAdapters.add(adapterId);
			}
		}

		this.#record('watcher_event', {
			projectWide: fullScope,
			pathCount: paths === null ? null : paths.length,
			adapterCount: fullScope ? null : adapterIds.length,
			adapterIds: fullScope ? null : adapterIds,
		});

		if (this.#state === 'building' || this.#running !== null) {
			this.#refreshAgain = true;
			this.#record('refresh_coalesced');

			if (adapterScopeIsAffected(this.#activeAdapterIds, fullScope, adapterIds)) {
				this.#abortActive();
			}

			debug('event during build coalesced', {fullScope, adapters: adapterIds});
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
		this.#allAdaptersDirty = true;
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
		this.#timers.clearDebounce();
		await this.#run(reason);
	}

	public markCurrent(): void {
		if (this.#state === 'stopping') {
			return;
		}

		this.#state = 'current';
		this.#dirtyPaths.clear();
		this.#activeDirtyPaths.clear();
		this.#dirtyAdapters.clear();
		this.#allAdaptersDirty = false;
		this.#projectWideInvalidation = false;
		this.#activeProjectWideInvalidation = false;
		this.#refreshAgain = false;
		this.#firstEventAt = null;
		this.#activeAdapterIds = null;
		this.#supersededAttempts = 0;
		this.#supersededBackoffMs = 0;
		this.#failureAttempts = 0;
		this.#timers.clearFailureRetry();
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
			dirtyFileCount: this.#dirtyFileCount(),
		});
		this.#schedule('change', backoffMs);
	}

	public getSnapshot(): RefreshCoordinatorSnapshotType {
		return {
			state: this.#state,
			checkedAt: this.#checkedAt,
			dirtyFileCount: this.#dirtyFileCount(),
			projectWideInvalidation: this.#isProjectWideInvalidation(),
			refreshAgain: this.#refreshAgain,
			lastRefreshStartedAt: this.#lastRefreshStartedAt,
			lastRefreshCompletedAt: this.#lastRefreshCompletedAt,
			lastError: this.#lastError,
			lastReason: this.#lastReason,
			refreshAdapterIds: this.#activeAdapterIds,
		};
	}

	public getFreshness(): QueryFreshnessType {
		return freshnessOf(this.getSnapshot());
	}

	public isPathDirty(filePath: string): boolean {
		return this.#isProjectWideInvalidation() || this.#dirtyPaths.has(filePath) || this.#activeDirtyPaths.has(filePath);
	}

	public async close(): Promise<void> {
		this.#state = 'stopping';
		this.#timers.clearAll();
		this.#abortActive();

		if (this.#running !== null) {
			try {
				await this.#running;
			} catch {
				// The refresh failure is already recorded.
			}
		}
	}

	#isProjectWideInvalidation(): boolean {
		return projectWideInvalidationOf(this.#projectWideInvalidation, this.#activeProjectWideInvalidation, this.#state);
	}

	#dirtyFileCount(): number | null {
		return dirtyFileCountOf({
			pendingProjectWide: this.#projectWideInvalidation,
			activeProjectWide: this.#activeProjectWideInvalidation,
			state: this.#state,
			pending: this.#dirtyPaths,
			active: this.#activeDirtyPaths,
		});
	}

	#abortActive(): void {
		if (this.#abort !== null && !this.#abort.signal.aborted) {
			this.#record('refresh_invalidated');
			debug('active refresh cancelled');
			this.#abort.abort();
		}
	}

	#schedule(reason: RefreshReasonType, delayMs = this.#debounceMs): void {
		const effectiveDelay = this.#supersededBackoffMs > 0 ? Math.max(delayMs, this.#supersededBackoffMs) : delayMs;
		this.#timers.scheduleDebounce(() => {
			void this.#run(reason);
		}, effectiveDelay);
	}

	/**
	 * Arms the optional safety reconciliation from now.
	 *
	 * One-shot by design: the next timer starts only after a refresh finishes, so
	 * a scan that takes longer than the interval cannot queue overlapping checks.
	 */
	#armReconcile(): void {
		this.#timers.clearReconcile();

		if (this.#reconcileIntervalMs <= 0 || this.#state === 'stopping') {
			return;
		}

		this.#timers.scheduleReconcile(() => {
			this.requestReconcile();
		}, this.#reconcileIntervalMs);
	}

	#armFailureRetry(): void {
		this.#timers.clearFailureRetry();

		if (this.#state === 'stopping') {
			return;
		}

		this.#failureAttempts += 1;
		const delayMs = Math.min(this.#debounceMs * 2 ** (this.#failureAttempts - 1), this.#failedRetryMaxMs);
		this.#timers.scheduleFailureRetry(() => {
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
	}

	async #run(reason: RefreshReasonType): Promise<void> {
		if (this.#state === 'stopping' || this.#running !== null) {
			return;
		}

		const adapterIds = scopeFor(reason, this.#allAdaptersDirty, this.#dirtyAdapters, this.#activeAdapterIds);
		const abort = new AbortController();
		this.#activeAdapterIds = adapterIds;
		this.#activeProjectWideInvalidation = adapterIds === null;
		this.#activeDirtyPaths.clear();

		for (const changedPath of this.#dirtyPaths) {
			this.#activeDirtyPaths.add(changedPath);
		}

		this.#dirtyPaths.clear();
		this.#dirtyAdapters.clear();
		this.#allAdaptersDirty = false;
		this.#projectWideInvalidation = false;
		this.#refreshAgain = false;
		this.#supersededBackoffMs = 0;
		this.#timers.clearFailureRetry();
		this.#state = 'building';
		this.#lastReason = reason;
		this.#lastRefreshStartedAt = new Date(this.#clock.now()).toISOString();
		const startedAt = this.#clock.now();
		this.#abort = abort;
		this.#record('refresh_started', {
			reason,
			dirtyFileCount: this.#dirtyFileCount(),
			adapterCount: adapterIds === null ? null : adapterIds.length,
			adapterIds,
		});
		debug('refresh run', {reason, adapters: adapterIds, dirtyPaths: this.#activeDirtyPaths.size, projectWide: this.#activeProjectWideInvalidation});
		this.#running = this.#execute(startedAt, abort.signal);

		try {
			await this.#running;
		} finally {
			this.#running = null;

			if (this.#abort === abort) {
				this.#abort = null;
			}
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
		this.#activeDirtyPaths.clear();
		this.#activeProjectWideInvalidation = false;
		this.#record('refresh_superseded', {
			reason: this.#lastReason,
			durationMs: Math.round(completedAt - startedAt),
			attempt: this.#supersededAttempts,
			backoffMs,
			dirtyFileCount: this.#dirtyFileCount(),
			adapterCount: this.#activeAdapterIds === null ? null : this.#activeAdapterIds.length,
			adapterIds: this.#activeAdapterIds,
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
		this.#timers.clearFailureRetry();
		this.#lastRefreshCompletedAt = new Date(completedAt).toISOString();
		this.#lastError = null;
		this.#record('refresh_published', {
			reason: this.#lastReason,
			durationMs: Math.round(completedAt - startedAt),
			eventToPublicationMs: Math.round(completedAt - (this.#firstEventAt ?? startedAt)),
			dirtyFileCount: this.#dirtyFileCount(),
			adapterCount: this.#activeAdapterIds === null ? null : this.#activeAdapterIds.length,
			adapterIds: this.#activeAdapterIds,
		});
		this.#activeDirtyPaths.clear();
		this.#activeProjectWideInvalidation = false;

		if (this.#refreshAgain) {
			this.#state = 'dirty';
			this.#refreshAgain = false;
			this.#schedule('change');
			return;
		}

		this.#state = 'current';
		this.#firstEventAt = null;
		this.#dirtyPaths.clear();
		this.#dirtyAdapters.clear();
		this.#allAdaptersDirty = false;
		this.#projectWideInvalidation = false;
	}

	async #execute(startedAt: number, signal: AbortSignal): Promise<void> {
		try {
			const outcome = await this.#runRefresh(this.#lastReason ?? 'manual', this.#activeAdapterIds, signal);
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
			this.#activeDirtyPaths.clear();
			this.#activeProjectWideInvalidation = false;
			this.#record('refresh_failed', {
				reason: this.#lastReason,
				durationMs: Math.round(completedAt - startedAt),
				eventToPublicationMs: Math.round(eventToPublicationMs),
				dirtyFileCount: this.#dirtyFileCount(),
				adapterIds: this.#activeAdapterIds,
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
