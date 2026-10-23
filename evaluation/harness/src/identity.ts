import {type ArtifactRefType} from './artifact.ts';
import {type EnvironmentManifestType} from './environment.ts';
import {hashOf} from './hash.ts';
import {hostedReferenceHashOf, type HostedReferenceType} from './hostedReference.ts';
import {SUITE_SCHEMA_VERSION, caseHashOf, type CaseType, type SuiteType} from './schema.ts';
import {canonicalTreatmentsOf, treatmentSetHashOf, type ToolSurfaceType, type TreatmentDefinitionType, type TreatmentKindType} from './treatment.ts';

/** Shared execution fields that must be identical for every treatment. */
export type SharedConfigurationType = Readonly<{
	ordinaryTools: readonly string[];
	codeMode: 'absent';
}>;

/** Pinned model identity, independent of whether the model is local or hosted. */
export type ModelPinType = Readonly<{
	id: string;
	digest: string;
}>;

/** Closed identity for one planned execution. */
export type IdentityType = Readonly<{
	harness: Readonly<{version: number; schemaVersion: number}>;
	suite: Readonly<{id: string; version: number; hash: string}>;
	model: string;
	/** Pinned local-model environment identity, or null for a hosted or unpinned model. */
	environment: Readonly<{id: string; hash: string}> | null;
	/** Pinned hosted reference identity, or null for a local or unpinned model. */
	hosted: ModelPinType | null;
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
	/** Pinned local-model environment, or null when the suite declares none. */
	environment?: EnvironmentManifestType | null;
	/** Pinned hosted reference, or null when the campaign is local or unpinned. */
	hostedReference?: HostedReferenceType | null;
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
 * are represented by the treatment-set hash; model, pinned environment,
 * revision, prompt, timeout, and the shared configuration stay outside it so a
 * mismatch is a different identity rather than a different treatment.
 *
 * @param input - Suite, selected cases, treatments, plan, harness version, and pinned environment.
 * @returns The identity object.
 */
export const identityOf = (input: IdentityInputType): IdentityType => {
	const treatments = canonicalTreatmentsOf(input.treatments);
	const shared = sharedConfigurationOf(treatments);

	return {
		harness: {version: input.harnessVersion, schemaVersion: SUITE_SCHEMA_VERSION},
		suite: {id: input.suite.id, version: input.suite.version, hash: input.suite.hash},
		model: input.suite.model,
		environment: input.environment === undefined || input.environment === null ? null : {id: input.environment.id, hash: hashOf(input.environment)},
		hosted:
			input.hostedReference === undefined || input.hostedReference === null
				? null
				: {id: input.hostedReference.id, digest: hostedReferenceHashOf(input.hostedReference)},
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

/** Schema version of the closed execution identity and its result envelope. */
export const EXECUTION_SCHEMA_VERSION = '1.0' as const;

/** Provider identity of the pinned model, as recorded in the run manifest. */
export type ExecutionModelIdentityType = Readonly<{
	provider: string;
	modelId: string;
	digest: string;
	quantization: string | null;
	runtime: string | null;
	runtimeVersion: string | null;
	generationSettingsDigest: string;
}>;

/** Identity of the agent definition and its exact interface. */
export type ExecutionAgentIdentityType = Readonly<{
	id: string;
	version: string;
	instructionsHash: string;
	toolListHash: string;
	permissionsHash: string;
	contextBudgetTokens: number;
}>;

/** Identity of one treatment arm and the interface it presents. */
export type ExecutionTreatmentIdentityType = Readonly<{
	id: string;
	kind: TreatmentKindType;
	definitionHash: string;
	mcpSurfaceHash: string;
}>;

/** Identity of the pinned subject checkout. */
export type ExecutionSubjectIdentityType = Readonly<{
	revision: string | null;
	isolationMode: string;
	contentManifestHash: string;
	projectFilesHash: string;
	lockFileHash: string | null;
	externalFixtureHash: string | null;
}>;

/** Complete identity for exactly one execution attempt. */
export type ExecutionIdentityType = Readonly<{
	harness: Readonly<{schemaVersion: string; version: number}>;
	suite: Readonly<{id: string; version: number; hash: string}>;
	case: Readonly<{id: string; hash: string; promptHash: string; timeoutMs: number}>;
	model: ExecutionModelIdentityType;
	agent: ExecutionAgentIdentityType;
	treatment: ExecutionTreatmentIdentityType;
	subject: ExecutionSubjectIdentityType;
	artifacts: Readonly<{accepted: ArtifactRefType | null; candidate: ArtifactRefType | null}>;
	codeIndex: Readonly<{configDigest: string}>;
	repetitionIndex: number;
	randomizationSeed: string;
}>;

export type ExecutionIdentityInputType = Readonly<{
	suite: SuiteType;
	testCase: CaseType;
	model: string;
	treatment: TreatmentDefinitionType;
	surface: ToolSurfaceType;
	subject: Readonly<{
		mode: string;
		revision: string | null;
		contentManifestHash: string;
		projectFilesHash?: string;
		lockFileHash: string | null;
		externalFixtureHash?: string | null;
	}>;
	artifacts: Readonly<{accepted: ArtifactRefType | null; candidate: ArtifactRefType | null}>;
	configDigest: string;
	repetitionIndex: number;
	randomizationSeed: string;
	harnessVersion: number;
	agent?: ExecutionAgentIdentityType;
	/** Pinned local-model environment, or null for a hosted or unpinned reference. */
	environment?: EnvironmentManifestType | null;
	/** Pinned hosted reference, or null for a local or unpinned model. */
	hostedReference?: HostedReferenceType | null;
}>;

/**
 * Builds the provider identity of the pinned model.
 *
 * A local environment supplies the immutable provider digest, quantization,
 * runtime version, and generation settings. A hosted reference supplies its
 * exact provider release, client runtime, and generation settings. Without
 * either, the suite pins only a reference, so hashing the reference is the
 * strongest available identity.
 *
 * @param model - Suite model reference.
 * @param environment - Pinned local-model environment, when the run uses one.
 * @param hosted - Pinned hosted reference, when the run uses one.
 * @returns Provider identity recorded in the result.
 */
const modelDigestOf = (model: string, environment: EnvironmentManifestType | null, hosted: HostedReferenceType | null): string => {
	if (environment !== null) {
		return environment.model.digest;
	}

	return hosted === null ? hashOf({model}) : hostedReferenceHashOf(hosted);
};

const modelRuntimeOf = (
	environment: EnvironmentManifestType | null,
	hosted: HostedReferenceType | null,
): Readonly<{runtime: string | null; version: string | null}> => {
	if (environment !== null) {
		return {runtime: 'ollama', version: environment.runtime.ollama};
	}

	return hosted === null ? {runtime: null, version: null} : {runtime: 'hosted', version: hosted.runtime.opencode};
};

const generationDigestOf = (model: string, environment: EnvironmentManifestType | null, hosted: HostedReferenceType | null): string => {
	if (environment !== null) {
		return hashOf({generation: environment.model.generation, contextLength: environment.model.contextLength});
	}

	return hosted === null ? hashOf({model}) : hashOf({generation: hosted.generation, releasedAt: hosted.releasedAt});
};

export const modelIdentityOf = (
	model: string,
	environment: EnvironmentManifestType | null = null,
	hosted: HostedReferenceType | null = null,
): ExecutionModelIdentityType => {
	const separator = model.indexOf('/');
	const {runtime, version} = modelRuntimeOf(environment, hosted);

	if (environment !== null && environment.model.reference !== model) {
		throw new Error(`environment pins "${environment.model.reference}" but the suite declares "${model}"`);
	}

	if (hosted !== null && hosted.reference !== model) {
		throw new Error(`hosted reference pins "${hosted.reference}" but the suite declares "${model}"`);
	}

	return {
		provider: separator > 0 ? model.slice(0, separator) : 'unknown',
		modelId: separator > 0 ? model.slice(separator + 1) : model,
		digest: modelDigestOf(model, environment, hosted),
		quantization: environment?.model.quantization ?? null,
		runtime,
		runtimeVersion: version,
		generationSettingsDigest: generationDigestOf(model, environment, hosted),
	};
};

const agentIdentityOf = (input: ExecutionIdentityInputType): ExecutionAgentIdentityType =>
	input.agent ?? {
		id: 'evaluator',
		version: String(input.harnessVersion),
		// The evaluator definition is generated by the harness and is identical in
		// every treatment. Its hash keeps a changed prompt a different identity.
		instructionsHash: hashOf('codeindex-evaluator-agent'),
		toolListHash: input.surface.digest,
		permissionsHash: input.configDigest,
		contextBudgetTokens: 0,
	};

/**
 * Builds the complete identity of one execution slot.
 *
 * Every field the result contract names is included, including the case prompt
 * and timeout, the resolved artifact references, the treatment interface, the
 * pinned subject, and the repetition. Two executions with any difference are
 * different identities and can never share a stored result.
 *
 * @param input - Suite, case, model, treatment, subject, plan position, and harness version.
 * @returns The closed execution identity.
 */
export const executionIdentityOf = (input: ExecutionIdentityInputType): ExecutionIdentityType => ({
	harness: {schemaVersion: EXECUTION_SCHEMA_VERSION, version: input.harnessVersion},
	suite: {id: input.suite.id, version: input.suite.version, hash: input.suite.hash},
	case: {
		id: input.testCase.id,
		hash: caseHashOf(input.testCase),
		promptHash: hashOf(input.testCase.prompt),
		timeoutMs: input.testCase.timeoutMs,
	},
	model: modelIdentityOf(input.model, input.environment ?? null, input.hostedReference ?? null),
	agent: agentIdentityOf(input),
	treatment: {
		id: input.treatment.id,
		kind: input.treatment.kind,
		definitionHash: input.treatment.definitionHash,
		mcpSurfaceHash: input.surface.digest,
	},
	subject: {
		revision: input.subject.revision,
		isolationMode: input.subject.mode,
		contentManifestHash: input.subject.contentManifestHash,
		projectFilesHash: input.subject.projectFilesHash ?? input.subject.contentManifestHash,
		lockFileHash: input.subject.lockFileHash,
		externalFixtureHash: input.subject.externalFixtureHash ?? null,
	},
	artifacts: {accepted: input.artifacts.accepted, candidate: input.artifacts.candidate},
	codeIndex: {configDigest: input.configDigest},
	repetitionIndex: input.repetitionIndex,
	randomizationSeed: input.randomizationSeed,
});

/**
 * Hashes one complete execution identity.
 *
 * @param identity - Closed execution identity.
 * @returns Lowercase hex SHA-256 digest.
 */
export const executionIdentityDigestOf = (identity: ExecutionIdentityType): string => hashOf(identity);

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
		environment: identity.environment,
		hosted: identity.hosted,
		revision: identity.revision,
		sharedConfigHash: identity.sharedConfigHash,
		cases: identity.cases,
		repetitions: identity.repetitions,
		planHash: identity.planHash,
	});

/**
 * Hashes the fields that must match across every result in a campaign.
 *
 * The case, treatment, repetition, candidate artifact, tool surface, and
 * CodeIndex configuration are deliberately excluded: each treatment presents a
 * different surface by design, and the paired comparison exists to measure that
 * difference. The evaluator persona, model, subject, accepted baseline, and
 * randomization seed must stay identical. Per-treatment tool and CodeIndex
 * consistency is enforced separately, so drift inside one treatment is still
 * rejected instead of being absorbed into the campaign digest.
 *
 * @param identity - Complete execution identity.
 * @returns Digest of the campaign-comparable fields.
 */
export const executionCampaignDigestOf = (identity: ExecutionIdentityType): string =>
	hashOf({
		harness: identity.harness,
		suite: identity.suite,
		model: identity.model,
		agent: {
			id: identity.agent.id,
			version: identity.agent.version,
			instructionsHash: identity.agent.instructionsHash,
			contextBudgetTokens: identity.agent.contextBudgetTokens,
		},
		subject: identity.subject,
		artifacts: {accepted: identity.artifacts.accepted},
		randomizationSeed: identity.randomizationSeed,
	});

/**
 * Hashes the comparison identity of one case.
 *
 * Two results enter a paired comparison for one case only when this digest is
 * equal. Treatment-specific fields and the candidate artifact are removed
 * because the comparison exists to measure them; everything else stays
 * compared.
 *
 * @param identity - Complete execution identity.
 * @returns Digest of the campaign-comparable fields plus the case.
 */
export const executionCaseComparisonDigestOf = (identity: ExecutionIdentityType): string =>
	hashOf({
		campaign: executionCampaignDigestOf(identity),
		case: identity.case,
	});
