export type ClockType = Readonly<{
	now: () => number;
	setTimeout: (action: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
	setInterval: (action: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}>;

/** Production clock used when no deterministic test clock is injected. */
export const systemClock: ClockType = {
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
