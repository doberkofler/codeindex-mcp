export {
	PUBLICATION_REACHABILITY_STEPS_PER_ROOT as FALLBACK_REACHABILITY_STEPS_PER_ROOT,
	PUBLICATION_SURFACE_BINDINGS_PER_ROOT as REPORT_SURFACE_BINDINGS_PER_ROOT,
} from '../../facts/ceilings.ts';

/**
 * Report-only projection probe budgets.
 *
 * These values bound a qualification probe, not a production generation. They
 * are at or above the accepted production ceilings so observed
 * maxima can be measured; a root that reaches a probe budget is reported as
 * incomplete and excluded from the maxima.
 */
export const PROJECTION_PROBE_MAX_ADDRESSES_PER_ROOT = 10_000;

/** Report-only reachability-step probe budget per root. */
export const PROJECTION_PROBE_MAX_REACHABILITY_STEPS_PER_ROOT = 50_000;

/** Target headroom over the measured maximum. */
export const HEADROOM_TARGET_FACTOR = 2;

/**
 * Rounds a computed headroom target up to the smallest 1/2/5 x 10^n value.
 *
 * @param observedMaximum - Measured per-root maximum.
 * @param headroomFactor - Required headroom factor.
 * @returns A stable ceiling, or `null` when no value was observed.
 */
export const headroomCeilingOf = (observedMaximum: number, headroomFactor: number = HEADROOM_TARGET_FACTOR): number | null => {
	if (observedMaximum <= 0) {
		return null;
	}

	const target = observedMaximum * headroomFactor;
	const magnitude = 10 ** Math.floor(Math.log10(target));

	for (const multiplier of [1, 2, 5, 10]) {
		const candidate = multiplier * magnitude;

		if (candidate >= target) {
			return candidate;
		}
	}

	return 10 * magnitude;
};
