import {type BenchmarkScenarioNameType} from './benchTypes.ts';

/** Benchmark step that can fail, named as it appears in reports. */
export type BenchmarkPhaseType = BenchmarkScenarioNameType | 'queries';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

/**
 * Formats SQLite's secondary diagnostics for one thrown value.
 *
 * `node:sqlite` reports the primary message only, which hides the extended
 * result code needed to tell a write failure from a short read or an mmap
 * failure. Both the numeric code and the library's own text are preserved.
 *
 * @param error - Value caught from a benchmark step.
 * @returns A suffix for the failure message, empty when no SQLite code is attached.
 */
const sqliteDetailOf = (error: unknown): string => {
	if (!isRecord(error)) {
		return '';
	}

	const {errcode, errstr} = error;

	if (typeof errcode !== 'number') {
		return '';
	}

	return ` (sqlite errcode ${String(errcode)}${typeof errstr === 'string' ? `: ${errstr}` : ''})`;
};

/**
 * Labels a failed benchmark step with the measurement that failed.
 *
 * One process and one database are shared by every scenario, so an unlabelled
 * error does not identify which phase produced it.
 *
 * @param phase - Scenario or measurement that failed.
 * @param error - Value thrown by the step.
 * @returns A new error naming the phase and retaining the original as its cause.
 */
const phaseFailure = (phase: BenchmarkPhaseType, error: unknown): Error => {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${phase} failed: ${message}${sqliteDetailOf(error)}`, {cause: error});
};

/**
 * Runs one benchmark step and labels any rejection with its phase.
 *
 * @param phase - Scenario or measurement being run.
 * @param pending - Already running step.
 * @returns The step's result.
 * @throws {@link Error} When the step rejects, labelled with the phase.
 */
export const phaseOf = async <ValueType>(phase: BenchmarkPhaseType, pending: Promise<ValueType>): Promise<ValueType> => {
	try {
		return await pending;
	} catch (error) {
		throw phaseFailure(phase, error);
	}
};
