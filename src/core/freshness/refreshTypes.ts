import {type LoggerType} from '../logging/logger.ts';
import {type BuildOutcomeType, type QueryFreshnessType, type RefreshStateType} from '../model.ts';
import {type ClockType} from './refreshClock.ts';
import {type RefreshAdapterScopeType, type RefreshReasonType} from './refreshScope.ts';

export {type RefreshReasonType} from './refreshScope.ts';

export const DEFAULT_DEBOUNCE_MS = 1000;
export const DEFAULT_SUPERSEDED_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_FAILED_RETRY_MAX_MS = 300_000;

export const noRecord = (_event: string, _fields?: Readonly<Record<string, unknown>>): void => {
	// Analytics are optional; the coordinator stays usable without a recorder.
};

export type RefreshRequestType = Readonly<{
	reason: RefreshReasonType;
	force: boolean;
	adapterIds?: RefreshAdapterScopeType;
	signal?: AbortSignal;
}>;

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
	/** Adapters captured by the running or most recent attempt, or null for all. */
	readonly refreshAdapterIds: readonly string[] | null;
}>;

export type RefreshCoordinatorOptionsType = Readonly<{
	runRefresh: (reason: RefreshReasonType, adapterIds: RefreshAdapterScopeType, signal: AbortSignal) => Promise<BuildOutcomeType>;
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

/**
 * Projects coordinator state into query freshness.
 *
 * @param snapshot - Current coordinator snapshot.
 * @returns Query freshness with the same checked-at and dirty count.
 */
export const freshnessOf = (snapshot: RefreshCoordinatorSnapshotType): QueryFreshnessType => {
	const state =
		snapshot.state === 'current'
			? 'current'
			: snapshot.state === 'dirty' || snapshot.state === 'building'
				? 'updating'
				: snapshot.state === 'failed'
					? 'stale'
					: 'unknown';

	return {state, checkedAt: snapshot.checkedAt, dirtyFileCount: snapshot.dirtyFileCount};
};
