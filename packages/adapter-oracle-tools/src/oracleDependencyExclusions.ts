/**
 * Every reason a package-dependency truth row can be omitted from a
 * qualification denominator.
 *
 * The list is part of the frozen O1 contract. Adding or removing a reason
 * requires a contract version bump and updated evidence.
 */
export const ORACLE_DEPENDENCY_EXCLUSION_REASONS = ['compiler_inferred_dependency'] as const;

export type OracleDependencyExclusionReasonType = (typeof ORACLE_DEPENDENCY_EXCLUSION_REASONS)[number];

export type DependencyExclusionCountsType = Readonly<Record<OracleDependencyExclusionReasonType, number>>;

/**
 * Creates a zeroed count for every dependency exclusion reason.
 *
 * @returns One zero-valued counter per exclusion reason.
 */
export const emptyDependencyExclusionCounts = (): Record<OracleDependencyExclusionReasonType, number> => ({
	compiler_inferred_dependency: 0,
});
