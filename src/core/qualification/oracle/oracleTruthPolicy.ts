export type OracleTruthPolicyVersionType = 'v1' | 'v2';

export type OracleTruthPolicyType = Readonly<{
	version: OracleTruthPolicyVersionType;
	supportedTypes: Readonly<Record<string, string>>;
	definitionTypes: ReadonlySet<string>;
	referenceUsages: ReadonlySet<string>;
	supportedKinds: ReadonlySet<string>;
	filterReferenceTypes: boolean;
}>;

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
 */
export const ORACLE_TRUTH_POLICY_V1: OracleTruthPolicyType = {
	version: 'v1',
	supportedTypes: V1_SUPPORTED_TYPES,
	definitionTypes: PROGRAM_UNIT_TYPES,
	referenceUsages: REFERENCE_USAGES,
	supportedKinds: kindsOf(V1_SUPPORTED_TYPES),
	filterReferenceTypes: false,
};

/**
 * Current qualification policy.
 *
 * V2 filters truth and indexed facts through the same supported-type map,
 * treats every supported `DEFINITION` row as a declaration, and maps loop
 * iterators to the extractor's variable kind.
 */
export const ORACLE_TRUTH_POLICY_V2: OracleTruthPolicyType = {
	version: 'v2',
	supportedTypes: V2_SUPPORTED_TYPES,
	definitionTypes: new Set(Object.keys(V2_SUPPORTED_TYPES)),
	referenceUsages: REFERENCE_USAGES,
	supportedKinds: kindsOf(V2_SUPPORTED_TYPES),
	filterReferenceTypes: true,
};

/**
 * Resolves a truth-policy version.
 *
 * @param version - Requested version; omitted selects the current policy.
 * @returns The selected policy.
 * @throws {Error} When the version is unknown.
 */
export const oracleTruthPolicyOf = (version?: string): OracleTruthPolicyType => {
	if (version === undefined || version === 'v2') {
		return ORACLE_TRUTH_POLICY_V2;
	}

	if (version === 'v1') {
		return ORACLE_TRUTH_POLICY_V1;
	}

	throw new Error(`Unknown Oracle truth policy: ${version}`);
};
