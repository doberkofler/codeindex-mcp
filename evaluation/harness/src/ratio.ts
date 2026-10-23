/**
 * Closed ratio states for comparisons whose baseline may be zero.
 *
 * A positive treatment over a zero baseline is not a zero ratio and is not a
 * finite improvement. It is unbounded until a non-zero baseline is observed.
 */
export const RATIO_STATES = ['finite', 'both-zero', 'positive-over-zero', 'zero-over-positive'] as const;

export type RatioStateType = (typeof RATIO_STATES)[number];

/** One ratio with an explicit state instead of a sentinel value. */
export type RatioType = Readonly<{
	state: RatioStateType;
	/** Finite value, 1 for two zeros, 0 for zero over positive, null when unbounded. */
	value: number | null;
}>;

/**
 * Computes a treatment/baseline ratio without collapsing zero cases.
 *
 * @param treatmentValue - Treatment value; must be finite and non-negative.
 * @param baselineValue - Baseline value; must be finite and non-negative.
 * @returns The ratio and its zero state.
 */
export const ratioOf = (treatmentValue: number, baselineValue: number): RatioType => {
	if (!Number.isFinite(treatmentValue) || !Number.isFinite(baselineValue) || treatmentValue < 0 || baselineValue < 0) {
		throw new Error('a ratio requires finite, non-negative values');
	}

	if (baselineValue === 0) {
		return treatmentValue === 0 ? {state: 'both-zero', value: 1} : {state: 'positive-over-zero', value: null};
	}

	return treatmentValue === 0 ? {state: 'zero-over-positive', value: 0} : {state: 'finite', value: treatmentValue / baselineValue};
};

/**
 * Returns the ratio as a number for a lower-is-better threshold.
 *
 * Positive over zero becomes positive infinity so a threshold can never read it
 * as an improvement. Both zeros are equal and therefore 1.
 *
 * @param treatmentValue - Treatment value.
 * @param baselineValue - Baseline value.
 * @returns A finite ratio, 0, 1, or positive infinity.
 */
export const ratioValueOf = (treatmentValue: number, baselineValue: number): number => {
	const ratio = ratioOf(treatmentValue, baselineValue);

	return ratio.state === 'positive-over-zero' ? Number.POSITIVE_INFINITY : (ratio.value ?? Number.POSITIVE_INFINITY);
};
