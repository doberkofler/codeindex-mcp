export type OracleTruthPolicyVersionType = 'v1' | 'v2' | 'v3' | 'v4' | 'v5';

export type OracleTruthPolicyType = Readonly<{
	version: OracleTruthPolicyVersionType;
	supportedTypes: Readonly<Record<string, string>>;
	definitionTypes: ReadonlySet<string>;
	referenceUsages: ReadonlySet<string>;
	supportedKinds: ReadonlySet<string>;
	filterReferenceTypes: boolean;
	/** True when a CALL row without an emitted occurrence is omitted from truth. */
	omitAmbiguousOverloadInCalls: boolean;
	/** True when parameters and routine-local declarations are omitted from truth. */
	excludeEphemeralDeclarations: boolean;
}>;

/**
 * PL/Scope object types that a qualification corpus can map to authored source.
 *
 * Other object types, such as tables or views, are outside the O1 truth
 * population and are counted but never enter a denominator.
 */
export const ORACLE_TRUTH_OBJECT_TYPES: ReadonlySet<string> = new Set(['PACKAGE', 'PACKAGE BODY', 'FUNCTION', 'PROCEDURE']);

const V1_SUPPORTED_TYPES: Readonly<Record<string, string>> = {
	PACKAGE: 'package',
	FUNCTION: 'function',
	PROCEDURE: 'procedure',
	'FORMAL IN': 'parameter',
	'FORMAL OUT': 'parameter',
	'FORMAL IN OUT': 'parameter',
	VARIABLE: 'variable',
	CONSTANT: 'constant',
	CURSOR: 'cursor',
	RECORD: 'record_type',
	'RECORD FIELD': 'field',
	SUBTYPE: 'subtype',
	EXCEPTION: 'exception',
	REFCURSOR: 'ref_cursor_type',
	'INDEX TABLE': 'collection_type',
	'ASSOCIATIVE ARRAY': 'collection_type',
	'NESTED TABLE': 'collection_type',
	VARRAY: 'collection_type',
};

const V2_SUPPORTED_TYPES: Readonly<Record<string, string>> = {
	...V1_SUPPORTED_TYPES,
	ITERATOR: 'variable',
	'RECORD ITERATOR': 'variable',
};

const PROGRAM_UNIT_TYPES = new Set(['PACKAGE', 'FUNCTION', 'PROCEDURE']);
const REFERENCE_USAGES = new Set(['REFERENCE', 'ASSIGNMENT', 'CALL']);
const kindsOf = (types: Readonly<Record<string, string>>): ReadonlySet<string> => new Set([...Object.values(types), 'package']);

/**
 * Historical qualification policy.
 *
 * V1 preserves the Phase 0 contract: references are not filtered by supported
 * identifier type, and only program-unit `DEFINITION` rows are declarations.
 * It exists only to replay retained historical evidence.
 */
export const ORACLE_TRUTH_POLICY_V1: OracleTruthPolicyType = {
	version: 'v1',
	supportedTypes: V1_SUPPORTED_TYPES,
	definitionTypes: PROGRAM_UNIT_TYPES,
	referenceUsages: REFERENCE_USAGES,
	supportedKinds: kindsOf(V1_SUPPORTED_TYPES),
	filterReferenceTypes: false,
	omitAmbiguousOverloadInCalls: false,
	excludeEphemeralDeclarations: false,
};

/**
 * Historical qualification policy.
 *
 * V2 filters truth and indexed facts through the same supported-type map,
 * treats every supported `DEFINITION` row as a declaration, and maps loop
 * iterators to the extractor's variable kind. Retained Phase 8 evidence was
 * produced with this policy. It exists only to replay that evidence.
 */
export const ORACLE_TRUTH_POLICY_V2: OracleTruthPolicyType = {
	version: 'v2',
	supportedTypes: V2_SUPPORTED_TYPES,
	definitionTypes: new Set(Object.keys(V2_SUPPORTED_TYPES)),
	referenceUsages: REFERENCE_USAGES,
	supportedKinds: kindsOf(V2_SUPPORTED_TYPES),
	filterReferenceTypes: true,
	omitAmbiguousOverloadInCalls: false,
	excludeEphemeralDeclarations: false,
};

/**
 * Authoritative O1 qualification policy.
 *
 * V3 is the contract executed by `qualify:oracle`. It is V2 plus the
 * publication-visible ambiguity rule: a `CALL` row that maps exactly to an
 * emitted `ambiguous-overload` diagnostic is omitted from the truth
 * denominator with a counted reason. The adapter emits no occurrence for that
 * site, so including the row in truth would count a policy-visible omission as
 * a recall failure.
 */
export const ORACLE_TRUTH_POLICY_V3: OracleTruthPolicyType = {
	...ORACLE_TRUTH_POLICY_V2,
	version: 'v3',
	omitAmbiguousOverloadInCalls: true,
	excludeEphemeralDeclarations: false,
};

/**
 * Authoritative O1 qualification policy.
 *
 * V4 aligns truth with the persisted publication surface: parameters and
 * declarations local to a routine are intentionally ephemeral, so they are
 * omitted with a counted reason instead of being counted as recall failures.
 * Package-level declarations, nested named routines, and every other supported
 * declaration remain in the denominators.
 */
export const ORACLE_TRUTH_POLICY_V4: OracleTruthPolicyType = {
	...ORACLE_TRUTH_POLICY_V3,
	version: 'v4',
	excludeEphemeralDeclarations: true,
};

/**
 * Identifier types for which a `DEFINITION` row is the declaration point.
 *
 * Oracle documents `DEFINITION` for exceptions and program units only: "a
 * DEFINITION tells the compiler how to implement or use a previously declared
 * identifier", and "for a top-level identifier only, the DEFINITION and
 * DECLARATION are in the same place". A scalar identifier has no `DEFINITION`,
 * yet Oracle 19c reports a bare Boolean predicate read (`IF flag THEN`) with
 * usage `DEFINITION`. V5 keeps the documented declaration meaning for program
 * units and exceptions, and maps every other supported type to a reference use.
 */
const DEFINITION_DECLARATION_TYPES = new Set([...PROGRAM_UNIT_TYPES, 'EXCEPTION']);

/**
 * Authoritative O1 qualification policy.
 *
 * V5 corrects the `DEFINITION` mapping that V2 widened to every supported
 * identifier type. That widening turned each scalar predicate read Oracle 19c
 * reports as `DEFINITION` into an invented declaration at the read site: the
 * declaration was then dropped as ephemeral, while the adapter's legitimate
 * reference at the same position counted as a false positive. V5 maps scalar
 * `DEFINITION` rows back to references and keeps every V4 rule unchanged.
 */
export const ORACLE_TRUTH_POLICY_V5: OracleTruthPolicyType = {
	...ORACLE_TRUTH_POLICY_V4,
	version: 'v5',
	definitionTypes: DEFINITION_DECLARATION_TYPES,
};

/**
 * Resolves a truth-policy version.
 *
 * @param version - Requested version; omitted selects the authoritative policy.
 * @returns The selected policy.
 * @throws {Error} When the version is unknown.
 */
export const oracleTruthPolicyOf = (version?: string): OracleTruthPolicyType => {
	if (version === undefined || version === 'v5') {
		return ORACLE_TRUTH_POLICY_V5;
	}

	if (version === 'v1') {
		return ORACLE_TRUTH_POLICY_V1;
	}

	if (version === 'v2') {
		return ORACLE_TRUTH_POLICY_V2;
	}

	if (version === 'v3') {
		return ORACLE_TRUTH_POLICY_V3;
	}

	if (version === 'v4') {
		return ORACLE_TRUTH_POLICY_V4;
	}

	throw new Error(`Unknown Oracle truth policy: ${version}`);
};
