import {createHash} from 'node:crypto';
import {ORACLE_DIAGNOSTIC} from '../../../adapters/oracle/diagnostics.ts';
import {ORACLE_COMPARISON_SAMPLE_LIMIT} from './oracleTruth.ts';
import {ORACLE_TRUTH_EXCLUSION_REASONS} from './oracleTruthExclusions.ts';
import {ORACLE_TRUTH_POLICY_V3, type OracleTruthPolicyVersionType} from './oracleTruthPolicy.ts';

type OracleQualificationThresholdsType = Readonly<{
	declarations: number;
	references: number;
	dependencies: number;
	precision: number;
}>;

export type OracleQualificationContractType = Readonly<{
	/** Stable contract family name. */
	id: 'oracle-o1';
	/** Contract revision; a semantic change increments it. */
	version: string;
	/** Truth policy executed by the contract. */
	truthPolicy: OracleTruthPolicyVersionType;
	/** PL/Scope object types that can enter the truth population. */
	objectTypes: readonly string[];
	/** Accuracy gates. Precision is exact. */
	thresholds: OracleQualificationThresholdsType;
	/** Empty truth can never satisfy a gate. */
	emptyTruth: 'fail';
	/** Retained disagreement samples per comparison. */
	sampleLimit: number;
	/** Stable reason codes for every omitted truth row. */
	exclusionReasons: readonly string[];
	/** A policy-visible ambiguity diagnostic omits exactly one CALL truth row. */
	ambiguity: Readonly<{diagnosticCode: number; usage: 'CALL'; positionMatch: 'exact path/line/column'}>;
	/** An unmapped PL/Scope object aborts the run instead of shrinking truth. */
	unmappedObject: 'abort';
	/** Execution identities that a report must record. */
	identity: Readonly<{
		parser: readonly string[];
		corpus: readonly string[];
		truth: readonly string[];
	}>;
}>;

/**
 * Authoritative Oracle O1 qualification contract.
 *
 * This object, not a command flag or a retained evidence file, names the
 * release gate. `qualify:oracle` executes it directly: truth normalization,
 * exclusion reasons, ambiguity handling, and every threshold come from here.
 * V1 and V2 truth policies remain selectable only to replay retained
 * historical evidence.
 */
export const ORACLE_QUALIFICATION_CONTRACT: OracleQualificationContractType = {
	id: 'oracle-o1',
	version: '1',
	truthPolicy: ORACLE_TRUTH_POLICY_V3.version,
	objectTypes: ['FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'PROCEDURE'],
	thresholds: {declarations: 0.995, references: 0.995, dependencies: 0.995, precision: 1},
	emptyTruth: 'fail',
	sampleLimit: ORACLE_COMPARISON_SAMPLE_LIMIT,
	exclusionReasons: [...ORACLE_TRUTH_EXCLUSION_REASONS],
	ambiguity: {diagnosticCode: ORACLE_DIAGNOSTIC.ambiguousOverload, usage: 'CALL', positionMatch: 'exact path/line/column'},
	unmappedObject: 'abort',
	identity: {
		parser: ['id', 'revision', 'compilerVersion'],
		corpus: ['files', 'objects', 'sourceHash', 'configHash'],
		truth: ['identifiersSha256', 'dependenciesSha256'],
	},
};

const canonicalContract = (contract: OracleQualificationContractType): string =>
	JSON.stringify({
		id: contract.id,
		version: contract.version,
		truthPolicy: contract.truthPolicy,
		objectTypes: contract.objectTypes,
		thresholds: contract.thresholds,
		emptyTruth: contract.emptyTruth,
		sampleLimit: contract.sampleLimit,
		exclusionReasons: contract.exclusionReasons,
		ambiguity: contract.ambiguity,
		unmappedObject: contract.unmappedObject,
		identity: contract.identity,
	});

export type OracleQualificationContractIdentityType = Readonly<{
	id: OracleQualificationContractType['id'];
	version: string;
	hash: string;
	truthPolicy: OracleTruthPolicyVersionType;
	thresholds: OracleQualificationThresholdsType;
	emptyTruth: 'fail';
	sampleLimit: number;
	objectTypes: readonly string[];
	exclusionReasons: readonly string[];
	ambiguity: OracleQualificationContractType['ambiguity'];
	unmappedObject: 'abort';
}>;

/**
 * Returns the committed contract identity.
 *
 * The hash covers every semantic field. A mismatch means the executable
 * contract changed and the evidence, tests, and documentation must move in the
 * same commit.
 *
 * @returns Stable contract identity for reports and evidence.
 */
export const oracleQualificationContractIdentityOf = (): OracleQualificationContractIdentityType => ({
	id: ORACLE_QUALIFICATION_CONTRACT.id,
	version: ORACLE_QUALIFICATION_CONTRACT.version,
	hash: createHash('sha256').update(canonicalContract(ORACLE_QUALIFICATION_CONTRACT)).digest('hex'),
	truthPolicy: ORACLE_QUALIFICATION_CONTRACT.truthPolicy,
	thresholds: ORACLE_QUALIFICATION_CONTRACT.thresholds,
	emptyTruth: ORACLE_QUALIFICATION_CONTRACT.emptyTruth,
	sampleLimit: ORACLE_QUALIFICATION_CONTRACT.sampleLimit,
	objectTypes: ORACLE_QUALIFICATION_CONTRACT.objectTypes,
	exclusionReasons: ORACLE_QUALIFICATION_CONTRACT.exclusionReasons,
	ambiguity: ORACLE_QUALIFICATION_CONTRACT.ambiguity,
	unmappedObject: ORACLE_QUALIFICATION_CONTRACT.unmappedObject,
});

type OracleGateResultType = Readonly<{ok: boolean; recall: boolean; precision: boolean}>;

export type OracleGatesType = Readonly<{
	declarations: OracleGateResultType;
	references: OracleGateResultType;
	dependencies: OracleGateResultType;
	ok: boolean;
}>;

export type OracleGateInputType = Readonly<{
	declarations: Readonly<{recall: number; precision: number}>;
	references: Readonly<{recall: number; precision: number}>;
	dependencies: Readonly<{recall: number; precision: number}>;
	identifierRows: number;
}>;

const gateOf = (metrics: Readonly<{recall: number; precision: number}>, recallThreshold: number): OracleGateResultType => ({
	recall: metrics.recall >= recallThreshold,
	precision: metrics.precision >= ORACLE_QUALIFICATION_CONTRACT.thresholds.precision,
	ok: metrics.recall >= recallThreshold && metrics.precision >= ORACLE_QUALIFICATION_CONTRACT.thresholds.precision,
});

/**
 * Evaluates every contract gate.
 *
 * Empty truth always fails: an empty export cannot prove accuracy, and a
 * vacuous comparison must never satisfy a release gate.
 *
 * @param input - Declaration, reference, and dependency metrics plus the truth row count.
 * @returns Per-section gate results and the aggregate result.
 */
export const oracleGatesOf = (input: OracleGateInputType): OracleGatesType => {
	if (input.identifierRows === 0) {
		const failed: OracleGateResultType = {ok: false, recall: false, precision: false};

		return {declarations: failed, references: failed, dependencies: failed, ok: false};
	}

	const declarations = gateOf(input.declarations, ORACLE_QUALIFICATION_CONTRACT.thresholds.declarations);
	const references = gateOf(input.references, ORACLE_QUALIFICATION_CONTRACT.thresholds.references);
	const dependencies = gateOf(input.dependencies, ORACLE_QUALIFICATION_CONTRACT.thresholds.dependencies);

	return {declarations, references, dependencies, ok: declarations.ok && references.ok && dependencies.ok};
};
