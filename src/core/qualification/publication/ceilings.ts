/**
 * Provisional report-only per-root ceilings.
 *
 * These values are explicitly non-normative. Policy requires final ceilings to
 * come from Phase 4 dry-run maxima plus documented headroom; until that slice
 * lands, they only bound qualification runs and keep DDL work blocked.
 */
export const PROVISIONAL_SURFACE_BINDINGS_PER_ROOT = 10_000;

/** Provisional report-only reachability-step ceiling per root. */
export const PROVISIONAL_REACHABILITY_STEPS_PER_ROOT = 50_000;

/** Target headroom over the eventual measured maximum. */
export const PROVISIONAL_HEADROOM_TARGET_FACTOR = 2;
