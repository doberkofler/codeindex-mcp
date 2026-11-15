import {debugFor} from '../logging/debug.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildReportType, type QueryFreshnessType} from '../model.ts';
import {systemClock, type ClockType} from './refreshClock.ts';
import {createRefreshReducerState, reduceRefresh, type ActiveRefreshAttemptType, type RefreshReducerStateType} from './refreshReducer.ts';
import {
	dirtyFileCount,
	freshnessFor,
	isDirtyPath,
	lastErrorOf,
	nextRefreshDeadline,
	projectWideInvalidation,
	refreshAgain,
	refreshStateOf,
} from './refreshSelectors.ts';
import {type RefreshAdapterScopeType} from './refreshScope.ts';
import {RefreshTimers} from './refreshTimers.ts';
import {
	DEFAULT_FAILED_RETRY_MAX_MS,
	DEFAULT_SUPERSEDED_BACKOFF_MAX_MS,
	noRecord,
	type RefreshChangeRequestType,
	type RefreshCoordinatorOptionsType,
	type RefreshCoordinatorSnapshotType,
	type RefreshManualRequestType,
	type RefreshReconcileRequestType,
	type RefreshStartupRequestType,
} from './refreshTypes.ts';

export {type ClockType} from './refreshClock.ts';
export {type RefreshAdapterScopeType} from './refreshScope.ts';
export {
	type RefreshChangeRequestType,
	type RefreshCoordinatorOptionsType,
	type RefreshCoordinatorSnapshotType,
	type RefreshManualRequestType,
	type RefreshReconcileRequestType,
	type RefreshStartupRequestType,
} from './refreshTypes.ts';

const debug = debugFor('refresh');

type WaitingRequestType = Readonly<{
	resolve: (report: BuildReportType) => void;
	reject: (error: unknown) => void;
}>;

const scopeIntersects = (attempt: ActiveRefreshAttemptType, adapterIds: RefreshAdapterScopeType): boolean =>
	adapterIds === null ||
	adapterIds.length === 0 ||
	attempt.adapterIds === null ||
	adapterIds.some((adapterId) => attempt.selectedAdapterIds.includes(adapterId));

/**
 * Owns refresh scheduling and freshness state.
 *
 * Every startup, watcher, reconciliation, and manual request enters through
 * {@link request}. Logical state changes only through the pure refresh reducer;
 * this class owns timers, cancellation, and execution side effects.
 */
export class RefreshCoordinator {
	readonly #runRefresh: RefreshCoordinatorOptionsType['runRefresh'];
	readonly #logger: LoggerType;
	readonly #failedAdapterId: (error: unknown) => string | null;
	readonly #clock: ClockType;
	readonly #reconcileIntervalMs: number;
	readonly #supersededBackoffMaxMs: number;
	readonly #failedRetryMaxMs: number;
	readonly #record: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	readonly #timers: RefreshTimers;
	readonly #waiting = new Map<string, WaitingRequestType>();
	#state: RefreshReducerStateType;
	#running: Promise<void> | null = null;
	#abort: AbortController | null = null;
	#nextRequestId = 1;
	#started = false;

	public constructor(options: RefreshCoordinatorOptionsType) {
		if (options.adapters.length === 0) {
			throw new Error('RefreshCoordinator requires at least one adapter');
		}

		const adapterIds = options.adapters.map((adapter) => adapter.id);

		if (new Set(adapterIds).size !== adapterIds.length) {
			throw new Error('RefreshCoordinator adapter identifiers must be unique');
		}

		this.#runRefresh = options.runRefresh;
		this.#logger = options.logger;
		this.#failedAdapterId = options.failedAdapterId ?? ((_error: unknown): null => null);
		this.#clock = options.clock ?? systemClock;
		this.#timers = new RefreshTimers(this.#clock);
		this.#reconcileIntervalMs = options.reconcileIntervalMs ?? 0;
		this.#supersededBackoffMaxMs = options.supersededBackoffMaxMs ?? DEFAULT_SUPERSEDED_BACKOFF_MAX_MS;
		this.#failedRetryMaxMs = options.failedRetryMaxMs ?? DEFAULT_FAILED_RETRY_MAX_MS;
		this.#record = options.record ?? noRecord;
		this.#state = createRefreshReducerState(options.adapters, this.#clock.now(), options.initiallyCurrent ?? false);
	}

	public start(): void {
		if (this.#started || this.#state.closed) {
			return;
		}

		this.#started = true;
		debug('coordinator start');
		this.#armReconcile();
		this.request({kind: 'startup'});
	}

	public request(requestValue: RefreshManualRequestType): Promise<BuildReportType>;
	public request(requestValue: RefreshChangeRequestType | RefreshReconcileRequestType | RefreshStartupRequestType): void;
	public request(
		requestValue: RefreshChangeRequestType | RefreshManualRequestType | RefreshReconcileRequestType | RefreshStartupRequestType,
	): Promise<BuildReportType> | void {
		if (requestValue.kind === 'manual') {
			return this.#requestManual(requestValue);
		}

		if (this.#state.closed) {
			return;
		}

		const now = this.#clock.now();

		if (requestValue.kind === 'change') {
			const {adapterIds, paths} = requestValue;
			const {active} = this.#state;
			this.#state = reduceRefresh(this.#state, {
				type: 'request',
				now,
				reason: 'change',
				adapterIds,
				paths,
				force: false,
				requestId: null,
				immediate: false,
				onlyIfClean: false,
			});
			this.#record('watcher_event', {
				projectWide: paths === null,
				pathCount: paths?.length ?? null,
				adapterCount: adapterIds?.length ?? null,
				adapterIds,
			});

			if (active !== null && scopeIntersects(active, adapterIds)) {
				this.#abortActive();
			}
		} else {
			const reason = requestValue.kind === 'startup' ? 'startup' : 'reconcile';
			this.#state = reduceRefresh(this.#state, {
				type: 'request',
				now,
				reason,
				adapterIds: null,
				paths: null,
				force: false,
				requestId: null,
				immediate: false,
				onlyIfClean: requestValue.kind === 'reconcile',
			});

			if (requestValue.kind === 'reconcile') {
				this.#record('watcher_reconcile');
			}
		}

		this.#schedule();
	}

	public getSnapshot(): RefreshCoordinatorSnapshotType {
		return {
			state: refreshStateOf(this.#state),
			checkedAt: new Date(this.#state.checkedAt).toISOString(),
			dirtyFileCount: dirtyFileCount(this.#state),
			projectWideInvalidation: projectWideInvalidation(this.#state),
			refreshAgain: refreshAgain(this.#state),
			lastRefreshStartedAt: this.#state.lastRefreshStartedAt === null ? null : new Date(this.#state.lastRefreshStartedAt).toISOString(),
			lastRefreshCompletedAt: this.#state.lastRefreshCompletedAt === null ? null : new Date(this.#state.lastRefreshCompletedAt).toISOString(),
			lastError: lastErrorOf(this.#state),
			lastReason: this.#state.lastReason,
			refreshAdapterIds: this.#state.active?.adapterIds ?? this.#state.lastAdapterIds,
		};
	}

	public getFreshness(adapterIds: RefreshAdapterScopeType = null): QueryFreshnessType {
		return freshnessFor(this.#state, adapterIds);
	}

	public isPathDirty(filePath: string, adapterId?: string): boolean {
		return isDirtyPath(this.#state, filePath, adapterId === undefined ? null : [adapterId]);
	}

	public async close(): Promise<void> {
		if (this.#state.closed) {
			return;
		}

		this.#state = reduceRefresh(this.#state, {type: 'close', now: this.#clock.now()});
		this.#timers.clearAll();
		this.#abortActive();
		const error = new Error('Refresh coordinator closed');

		for (const waiting of this.#waiting.values()) {
			waiting.reject(error);
		}

		this.#waiting.clear();

		if (this.#running !== null) {
			await this.#running;
		}
	}

	async #requestManual(requestValue: RefreshManualRequestType): Promise<BuildReportType> {
		if (this.#state.closed) {
			throw new Error('Refresh coordinator closed');
		}

		const requestId = String(this.#nextRequestId);
		this.#nextRequestId += 1;
		const result = Promise.withResolvers<BuildReportType>();
		this.#waiting.set(requestId, {resolve: result.resolve, reject: result.reject});
		this.#state = reduceRefresh(this.#state, {
			type: 'request',
			now: this.#clock.now(),
			reason: 'manual',
			adapterIds: null,
			paths: null,
			force: requestValue.force,
			requestId,
			immediate: true,
			onlyIfClean: false,
		});
		this.#schedule();
		try {
			return await result.promise;
		} finally {
			this.#waiting.delete(requestId);
		}
	}

	#abortActive(): void {
		if (this.#abort !== null && !this.#abort.signal.aborted) {
			this.#record('refresh_invalidated');
			debug('active refresh cancelled');
			this.#abort.abort();
		}
	}

	#schedule(): void {
		this.#timers.clearDebounce();
		const deadline = nextRefreshDeadline(this.#state);

		if (deadline === null) {
			return;
		}

		const delayMs = Math.max(0, deadline - this.#clock.now());

		if (delayMs === 0) {
			this.#startAttempt();
			return;
		}

		this.#timers.scheduleDebounce(() => {
			this.#startAttempt();
		}, delayMs);
	}

	#startAttempt(): void {
		if (this.#running !== null || this.#state.closed) {
			return;
		}

		this.#state = reduceRefresh(this.#state, {type: 'capture', now: this.#clock.now()});
		const attempt = this.#state.active;

		if (attempt === null) {
			this.#schedule();
			return;
		}

		const abort = new AbortController();
		this.#abort = abort;
		this.#record('refresh_started', {
			reason: attempt.reason,
			dirtyFileCount: dirtyFileCount(this.#state, attempt.adapterIds),
			adapterCount: attempt.adapterIds?.length ?? null,
			adapterIds: attempt.adapterIds,
			force: attempt.force,
		});
		debug('refresh run', {reason: attempt.reason, adapters: attempt.adapterIds, force: attempt.force});
		this.#running = this.#runAttempt(attempt, abort);
	}

	async #runAttempt(attempt: ActiveRefreshAttemptType, abort: AbortController): Promise<void> {
		try {
			await this.#execute(attempt, abort.signal);
		} finally {
			this.#running = null;
			if (this.#abort === abort) {
				this.#abort = null;
			}

			this.#armReconcile();
			this.#schedule();
		}
	}

	async #execute(attempt: ActiveRefreshAttemptType, signal: AbortSignal): Promise<void> {
		try {
			const report = await this.#runRefresh(attempt.reason, attempt.adapterIds, attempt.force, signal);
			this.#completeReport(attempt, report);
		} catch (error) {
			this.#completeFailure(attempt, error);
		}
	}

	#completeReport(attempt: ActiveRefreshAttemptType, report: BuildReportType): void {
		const completedAt = this.#clock.now();
		const completedAttempt = this.#completedAttempt(attempt);

		if (report.outcome === 'superseded') {
			this.#state = reduceRefresh(this.#state, {
				type: 'superseded',
				now: completedAt,
				attemptId: attempt.id,
				maximumBackoffMs: this.#supersededBackoffMaxMs,
			});
			const backoffMs = Math.max(
				0,
				...completedAttempt.selectedAdapterIds.map((adapterId) => (this.#state.adapters.get(adapterId)?.backoffDeadline ?? completedAt) - completedAt),
			);
			this.#record('refresh_superseded', {
				reason: attempt.reason,
				durationMs: Math.round(completedAt - attempt.startedAt),
				backoffMs,
				dirtyFileCount: dirtyFileCount(this.#state),
				adapterCount: attempt.adapterIds?.length ?? null,
				adapterIds: attempt.adapterIds,
			});
		} else {
			this.#state = reduceRefresh(this.#state, {type: 'published', now: completedAt, attemptId: attempt.id});
			this.#record('refresh_published', {
				reason: attempt.reason,
				durationMs: Math.round(completedAt - attempt.startedAt),
				eventToPublicationMs: Math.round(completedAt - attempt.firstDirtyAt),
				dirtyFileCount: dirtyFileCount(this.#state),
				adapterCount: attempt.adapterIds?.length ?? null,
				adapterIds: attempt.adapterIds,
			});
		}

		for (const requestId of completedAttempt.requestIds) {
			this.#waiting.get(requestId)?.resolve(report);
			this.#waiting.delete(requestId);
		}
	}

	#completeFailure(attempt: ActiveRefreshAttemptType, error: unknown): void {
		const completedAt = this.#clock.now();
		const completedAttempt = this.#completedAttempt(attempt);
		const message = error instanceof Error ? error.message : String(error);
		const attributedAdapterId = this.#failedAdapterId(error);
		const failedAdapterId = attributedAdapterId !== null && completedAttempt.selectedAdapterIds.includes(attributedAdapterId) ? attributedAdapterId : null;
		this.#state = reduceRefresh(this.#state, {
			type: 'failed',
			now: completedAt,
			attemptId: attempt.id,
			adapterId: failedAdapterId,
			error: message,
			maximumRetryMs: this.#failedRetryMaxMs,
		});
		this.#record('refresh_failed', {
			reason: attempt.reason,
			durationMs: Math.round(completedAt - attempt.startedAt),
			eventToPublicationMs: Math.round(completedAt - attempt.firstDirtyAt),
			dirtyFileCount: dirtyFileCount(this.#state),
			adapterIds: attempt.adapterIds,
		});
		this.#logger.error('refresh_failed', {message});

		for (const requestId of completedAttempt.requestIds) {
			this.#waiting.get(requestId)?.reject(error);
			this.#waiting.delete(requestId);
		}
	}

	#completedAttempt(attempt: ActiveRefreshAttemptType): ActiveRefreshAttemptType {
		return this.#state.active?.id === attempt.id ? this.#state.active : attempt;
	}

	#armReconcile(): void {
		this.#timers.clearReconcile();

		if (this.#reconcileIntervalMs <= 0 || this.#state.closed) {
			return;
		}

		this.#timers.scheduleReconcile(() => {
			this.request({kind: 'reconcile'});
		}, this.#reconcileIntervalMs);
	}
}
