import {type LoggerType} from '../logging/logger.ts';
import {type BuildReportType, type RefreshStateType} from '../model.ts';
import {type ClockType} from './refreshClock.ts';
import {type RefreshAdapterDefinitionType} from './refreshReducer.ts';
import {type RefreshAdapterScopeType, type RefreshReasonType} from './refreshScope.ts';

export const DEFAULT_DEBOUNCE_MS = 1000;
export const DEFAULT_SUPERSEDED_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_FAILED_RETRY_MAX_MS = 300_000;

export const noRecord = (_event: string, _fields?: Readonly<Record<string, unknown>>): void => {
	// Analytics are optional; the coordinator stays usable without a recorder.
};

export type RefreshChangeRequestType = Readonly<{
	kind: 'change';
	paths: readonly string[] | null;
	adapterIds: RefreshAdapterScopeType;
}>;

export type RefreshManualRequestType = Readonly<{
	kind: 'manual';
	force: boolean;
}>;

export type RefreshReconcileRequestType = Readonly<{
	kind: 'reconcile';
}>;

export type RefreshStartupRequestType = Readonly<{
	kind: 'startup';
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
	runRefresh: (reason: RefreshReasonType, adapterIds: RefreshAdapterScopeType, force: boolean, signal: AbortSignal) => Promise<BuildReportType>;
	/** Resolves an adapter-attributed failure; null means the attempt failed globally. */
	failedAdapterId?: (error: unknown) => string | null;
	logger: LoggerType;
	adapters: readonly RefreshAdapterDefinitionType[];
	initiallyCurrent?: boolean;
	clock?: ClockType;
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
