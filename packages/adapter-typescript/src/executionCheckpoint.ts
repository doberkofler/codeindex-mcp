import {type AdapterExecutionContextType} from '@codeindex/adapter-sdk';

const CHECK_INTERVAL = 256;

/**
 * Builds a cheap checkpoint that performs one shared-memory-backed check per
 * bounded batch rather than per trivial syntax node.
 *
 * @param context - Optional host execution context.
 * @returns A checkpoint suitable for hot traversal loops.
 */
export const createExecutionCheckpoint = (context: AdapterExecutionContextType | undefined): (() => void) => {
	let count = 0;

	return (): void => {
		count += 1;

		if (count === 1 || count % CHECK_INTERVAL === 0) {
			context?.throwIfCancellationRequested();
		}
	};
};
