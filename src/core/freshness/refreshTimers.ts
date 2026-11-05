import {type ClockType} from './refreshClock.ts';

type TimerHandleType = ReturnType<typeof setTimeout>;

/**
 * Owns the three independent timers used by the refresh coordinator.
 *
 * Every timer is one-shot and unref'd, so an idle workspace never keeps the
 * process alive and a callback cannot overlap the attempt it schedules.
 */
export class RefreshTimers {
	readonly #clock: ClockType;
	#debounce: TimerHandleType | null = null;
	#reconcile: TimerHandleType | null = null;
	#failureRetry: TimerHandleType | null = null;

	public constructor(clock: ClockType) {
		this.#clock = clock;
	}

	public scheduleDebounce(action: () => void, delayMs: number): void {
		this.clearDebounce();
		this.#debounce = this.#clock.setTimeout(() => {
			this.#debounce = null;
			action();
		}, delayMs);
		this.#debounce.unref();
	}

	public clearDebounce(): void {
		if (this.#debounce !== null) {
			this.#clock.clearTimeout(this.#debounce);
			this.#debounce = null;
		}
	}

	public scheduleReconcile(action: () => void, delayMs: number): void {
		this.clearReconcile();
		this.#reconcile = this.#clock.setTimeout(() => {
			this.#reconcile = null;
			action();
		}, delayMs);
		this.#reconcile.unref();
	}

	public clearReconcile(): void {
		if (this.#reconcile !== null) {
			this.#clock.clearTimeout(this.#reconcile);
			this.#reconcile = null;
		}
	}

	public scheduleFailureRetry(action: () => void, delayMs: number): void {
		this.clearFailureRetry();
		this.#failureRetry = this.#clock.setTimeout(() => {
			this.#failureRetry = null;
			action();
		}, delayMs);
		this.#failureRetry.unref();
	}

	public clearFailureRetry(): void {
		if (this.#failureRetry !== null) {
			this.#clock.clearTimeout(this.#failureRetry);
			this.#failureRetry = null;
		}
	}

	public clearAll(): void {
		this.clearDebounce();
		this.clearReconcile();
		this.clearFailureRetry();
	}
}
