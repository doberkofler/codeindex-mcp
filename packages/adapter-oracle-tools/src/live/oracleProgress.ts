// Formats a duration for terminal progress output.
export const formatDuration = (durationMs: number): string => {
	const seconds = Math.max(0, Math.round(durationMs / 1000));

	if (seconds < 60) {
		return `${String(seconds)}s`;
	}

	return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, '0')}s`;
};

/**
 * Formats one counted phase line. While work remains it reports an ETA derived
 * from the observed rate; the final line reports elapsed time instead.
 *
 * @param label - Phase name, for example `Targets`.
 * @param completed - Objects completed so far.
 * @param total - Objects in the phase.
 * @param elapsedMs - Time spent in the phase.
 * @returns One progress line without per-object detail.
 */
export const phaseProgressLine = (label: string, completed: number, total: number, elapsedMs: number): string => {
	if (completed <= 0) {
		return `${label}: 0/${String(total)}, ${formatDuration(elapsedMs)} elapsed`;
	}

	if (completed >= total) {
		return `${label}: ${String(total)}/${String(total)} complete in ${formatDuration(elapsedMs)}`;
	}

	const etaMs = (elapsedMs / completed) * (total - completed);

	return `${label}: ${String(completed)}/${String(total)}, ETA ~${formatDuration(etaMs)}`;
};
