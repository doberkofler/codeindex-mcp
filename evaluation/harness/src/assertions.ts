/** Closed result for one graded check. */
export const CHECK_RESULTS = ['pass', 'fail', 'unevaluated'] as const;

export type CheckResultType = (typeof CHECK_RESULTS)[number];

/** One auditable assertion inside a correctness, workflow, or post-run check. */
export type AssertionType = Readonly<{
	/** Stable identifier for the predicate. */
	id: string;
	/** Predicate family, for example `file-set` or `budget`. */
	kind: string;
	/** Declared expectation; a JSON value. */
	expected: unknown;
	/** Measured observation; a JSON value. */
	observed: unknown;
	result: CheckResultType;
}>;

/**
 * Folds assertions into one check result without hiding an unevaluated predicate.
 *
 * A failure dominates, an unevaluated predicate makes the check unevaluated, and
 * an empty assertion list is a pass only because a caller with no predicate has
 * nothing to reject.
 *
 * @param assertions - Assertions in declaration order.
 * @returns The aggregate result.
 */
export const resultOf = (assertions: readonly AssertionType[]): CheckResultType => {
	if (assertions.some((assertion) => assertion.result === 'fail')) {
		return 'fail';
	}

	return assertions.some((assertion) => assertion.result === 'unevaluated') ? 'unevaluated' : 'pass';
};

/**
 * Builds one assertion.
 *
 * @param input - Identifier, kind, expectation, observation, and result.
 * @returns The immutable assertion.
 */
export const assertionOf = (
	input: Readonly<{
		id: string;
		kind: string;
		expected: unknown;
		observed: unknown;
		result: CheckResultType;
	}>,
): AssertionType => input;

/**
 * Returns the failed assertions as human-readable violations.
 *
 * @param assertions - Assertions to inspect.
 * @returns One message per failed assertion.
 */
export const violationsOf = (assertions: readonly AssertionType[]): readonly string[] =>
	assertions
		.filter((assertion) => assertion.result === 'fail')
		.map((assertion) => `${assertion.id}: expected ${JSON.stringify(assertion.expected)}, observed ${JSON.stringify(assertion.observed)}`);
