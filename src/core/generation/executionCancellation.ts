import {type AdapterExecutionContextType} from '@codeindex/adapter-sdk';

const CANCELLED = 1;

/** Error used only to unwind cooperative work before publication. */
export class BuildCancellationError extends Error {
	public constructor() {
		super('Build cancelled');
		this.name = 'BuildCancellationError';
	}
}

/**
 * Creates one shared cancellation cell for a worker request.
 *
 * @returns Zeroed shared cancellation memory.
 */
export const createCancellationBuffer = (): SharedArrayBuffer => new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

/**
 * Atomically marks one worker request as cancelled.
 *
 * @param buffer - Request-local cancellation memory.
 */
export const cancelExecution = (buffer: SharedArrayBuffer): void => {
	Atomics.store(new Int32Array(buffer), 0, CANCELLED);
	Atomics.notify(new Int32Array(buffer), 0);
};

/**
 * Builds the adapter execution context backed by one shared cancellation cell.
 *
 * @param buffer - Request-local cancellation memory.
 * @returns Context that observes cancellation synchronously.
 */
export const executionContextOf = (buffer: SharedArrayBuffer): AdapterExecutionContextType => {
	const cell = new Int32Array(buffer);
	const isCancellationRequested = (): boolean => Atomics.load(cell, 0) === CANCELLED;

	return {
		isCancellationRequested,
		throwIfCancellationRequested: (): void => {
			if (isCancellationRequested()) {
				throw new BuildCancellationError();
			}
		},
	};
};
