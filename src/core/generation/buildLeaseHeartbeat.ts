export type BuildLeaseHeartbeatFailureType = 'lost' | 'error';

/**
 * Starts opportunistic build-lease renewal.
 *
 * The timer callback must never throw. A failed renewal is informative, not
 * fatal: the owner still holds the lease row, and publication renews or rejects
 * it atomically. Throwing here would terminate the process because the callback
 * runs outside any request's error boundary.
 *
 * @param input - Renewal callback, interval, and failure reporter.
 * @returns A function that stops the heartbeat.
 */
export const startBuildLeaseHeartbeat = (
	input: Readonly<{
		renew: () => boolean;
		intervalMs: number;
		onFailure: (failure: BuildLeaseHeartbeatFailureType, error?: unknown) => void;
	}>,
): (() => void) => {
	const timer = setInterval(() => {
		try {
			if (!input.renew()) {
				input.onFailure('lost');
			}
		} catch (error) {
			input.onFailure('error', error);
		}
	}, input.intervalMs);
	timer.unref();

	return () => {
		clearInterval(timer);
	};
};
