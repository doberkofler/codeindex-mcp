import {hashOf} from './hash.ts';
import {SUITE_SCHEMA_VERSION, caseHashOf, type CaseType, type SuiteType} from './schema.ts';
import {canonicalTreatmentsOf, treatmentSetHashOf, type TreatmentDefinitionType} from './treatment.ts';

/** Shared execution fields that must be identical for every treatment. */
export type SharedConfigurationType = Readonly<{
	ordinaryTools: readonly string[];
	codeMode: 'absent';
}>;

/** Closed identity for one planned execution. */
export type IdentityType = Readonly<{
	harness: Readonly<{version: number; schemaVersion: number}>;
	suite: Readonly<{id: string; version: number; hash: string}>;
	model: string;
	revision: string;
	treatments: readonly Readonly<{id: string; definitionHash: string}>[];
	treatmentSetHash: string;
	sharedConfigHash: string;
	cases: readonly Readonly<{id: string; hash: string; promptHash: string; timeoutMs: number}>[];
	repetitions: number;
	planHash: string;
}>;

export type IdentityInputType = Readonly<{
	suite: SuiteType;
	cases: readonly CaseType[];
	treatments: readonly TreatmentDefinitionType[];
	repetitions: number;
	planHash: string;
	harnessVersion: number;
}>;

/**
 * Returns the configuration every treatment must share.
 *
 * @param treatments - Validated, equivalent treatment definitions.
 * @returns The ordinary tool policy and generic `execute` policy.
 */
export const sharedConfigurationOf = (treatments: readonly TreatmentDefinitionType[]): SharedConfigurationType => {
	const [first] = canonicalTreatmentsOf(treatments);

	if (first === undefined) {
		throw new Error('identity requires at least one treatment');
	}

	return {ordinaryTools: first.ordinaryTools, codeMode: first.codeMode};
};

/**
 * Builds the closed identity for one execution.
 *
 * Every field that can change an answer is included. Treatment-specific fields
 * are represented by the treatment-set hash; model, revision, prompt, timeout,
 * and the shared configuration stay outside it so a mismatch is a different
 * identity rather than a different treatment.
 *
 * @param input - Suite, selected cases, treatments, plan, and harness version.
 * @returns The identity object.
 */
export const identityOf = (input: IdentityInputType): IdentityType => {
	const treatments = canonicalTreatmentsOf(input.treatments);
	const shared = sharedConfigurationOf(treatments);

	return {
		harness: {version: input.harnessVersion, schemaVersion: SUITE_SCHEMA_VERSION},
		suite: {id: input.suite.id, version: input.suite.version, hash: input.suite.hash},
		model: input.suite.model,
		revision: input.suite.revision,
		treatments: treatments.map((treatment) => ({id: treatment.id, definitionHash: treatment.definitionHash})),
		treatmentSetHash: treatmentSetHashOf(treatments),
		sharedConfigHash: hashOf(shared),
		cases: input.cases.map((testCase) => ({
			id: testCase.id,
			hash: caseHashOf(testCase),
			promptHash: hashOf(testCase.prompt),
			timeoutMs: testCase.timeoutMs,
		})),
		repetitions: input.repetitions,
		planHash: input.planHash,
	};
};

/**
 * Hashes a complete identity.
 *
 * @param identity - Closed identity object.
 * @returns Lowercase hex SHA-256 digest.
 */
export const identityDigestOf = (identity: IdentityType): string => hashOf(identity);

/**
 * Hashes the fields that must match for two results to enter one paired
 * comparison.
 *
 * Treatment definitions and their resulting interface are removed, because a
 * paired comparison exists precisely to compare those. Everything else,
 * including model, revision, prompts, timeouts, shared configuration, suite, and
 * plan, stays compared.
 *
 * @param identity - Closed identity object.
 * @returns Digest of the comparable fields.
 */
export const comparisonDigestOf = (identity: IdentityType): string =>
	hashOf({
		harness: identity.harness,
		suite: identity.suite,
		model: identity.model,
		revision: identity.revision,
		sharedConfigHash: identity.sharedConfigHash,
		cases: identity.cases,
		repetitions: identity.repetitions,
		planHash: identity.planHash,
	});
