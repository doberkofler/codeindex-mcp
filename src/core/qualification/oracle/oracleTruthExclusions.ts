/**
 * Every reason a truth row can be omitted from a qualification denominator.
 *
 * The list is part of the frozen O1 contract. Adding or removing a reason
 * requires a contract version bump and updated evidence.
 */
export const ORACLE_TRUTH_EXCLUSION_REASONS = [
	'unsupported_identifier_type',
	'unmapped_usage',
	'invalid_declaration',
	'package_reference',
	'missing_group_declaration',
	'declaration_initializer',
	'duplicate_fact',
	'omitted_ambiguous_overload',
] as const;

export type OracleTruthExclusionReasonType = (typeof ORACLE_TRUTH_EXCLUSION_REASONS)[number];

type OracleTruthExclusionRoleType = 'declaration' | 'reference' | 'none';

export type ExcludedTruthFactType = Readonly<{
	path: string;
	line: number;
	column: number;
	name: string;
	type: string;
	role: OracleTruthExclusionRoleType;
	reason: OracleTruthExclusionReasonType;
}>;

export type TruthExclusionCountsType = Readonly<Record<OracleTruthExclusionReasonType, number>>;

/**
 * Creates a zeroed count for every contract reason.
 *
 * @returns One zero-valued counter per exclusion reason.
 */
export const emptyTruthExclusionCounts = (): Record<OracleTruthExclusionReasonType, number> => ({
	unsupported_identifier_type: 0,
	unmapped_usage: 0,
	invalid_declaration: 0,
	package_reference: 0,
	missing_group_declaration: 0,
	declaration_initializer: 0,
	duplicate_fact: 0,
	omitted_ambiguous_overload: 0,
});

/**
 * Builds a position-only key that pairs a truth row with an emitted diagnostic.
 *
 * @param position - Authored path, line, and column.
 * @returns Stable key without a symbol name.
 */
export const positionKeyOf = (position: Readonly<{path: string; line: number; column: number}>): string =>
	`${position.path}:${String(position.line)}:${String(position.column)}`;
