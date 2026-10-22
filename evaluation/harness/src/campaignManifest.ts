import os from 'node:os';
import {artifactRefOf} from './artifact.ts';
import {environmentHashOf, hostFactsOf} from './environment.ts';
import {EXECUTION_SCHEMA_VERSION, modelIdentityOf} from './identity.ts';
import {campaignStoreRecordOf, isolationRecordOf} from './isolation.ts';
import {caseHashOf} from './schema.ts';
import {treatmentDifferencesOf, type ToolSurfaceType, type TreatmentIdType} from './treatment.ts';
import {HARNESS_VERSION, type artifactsOf, type surfacesOf} from './cliSupport.ts';
import {type EvaluationSetupType} from './cliEvaluate.ts';

/** Campaign manifest: the pinned facts every slot identity derives from. */
export type CampaignManifestType = Readonly<{
	campaignId: string;
	schemaVersion: string;
	identityDigest: string;
	comparisonDigest: string;
	claimClass: string;
	suite: Readonly<{id: string; version: number; status: string; hash: string}>;
	components: Readonly<Record<string, string | number>>;
}> &
	Readonly<Record<string, unknown>>;

const surfaceForOf = (surfaces: Awaited<ReturnType<typeof surfacesOf>>, treatment: {id: TreatmentIdType}): ToolSurfaceType => {
	const surface = surfaces.get(treatment.id);

	if (surface === undefined) {
		throw new Error(`treatment ${treatment.id} has no captured tool surface`);
	}

	return surface;
};

/**
 * Builds the campaign manifest written before the first execution.
 *
 * @param setup - Resolved plan, identity, and pinned subject.
 * @param derived - Artifacts, captured surfaces, and configuration digests.
 * @param claimClass - Declared evidence class; never inferred from results.
 * @returns The manifest record.
 */
export const campaignManifestOf = (
	setup: EvaluationSetupType,
	derived: Readonly<{
		artifacts: ReturnType<typeof artifactsOf>;
		surfaces: Awaited<ReturnType<typeof surfacesOf>>;
		treatmentContexts: ReadonlyMap<TreatmentIdType, Readonly<{surface: ToolSurfaceType; configDigest: string}>>;
	}>,
	claimClass = 'none',
): CampaignManifestType => {
	const {suite, selected, treatments, repetitions, environment, plan, planHash, identity, identityDigest, comparisonDigest, subject, clientStore} = setup;
	const campaignId = `${suite.id}-${identityDigest.slice(0, 16)}`;
	const randomizationSeed = identityDigest;
	const modelIdentity = modelIdentityOf(suite.model, environment);
	const environmentFacts = {...hostFactsOf(), referenceMachine: environment?.host.referenceMachine ?? os.hostname()};
	const {artifacts, surfaces, treatmentContexts} = derived;
	const manifestTreatments = treatments.map((treatment) => {
		const surface = surfaceForOf(surfaces, treatment);
		const {configDigest} = treatmentContexts.get(treatment.id) ?? {configDigest: ''};
		const artifact = artifacts.get(treatment.id) ?? null;

		return {
			id: treatment.id,
			kind: treatment.kind,
			definitionHash: treatment.definitionHash,
			configDigest,
			artifact:
				artifact === null
					? null
					: {
							id: artifact.id,
							root: artifact.root,
							entryPoint: artifact.entryPoint,
							digest: artifact.digest,
							declaredDigest: artifact.declaredDigest,
							fileCount: artifact.fileCount,
						},
			mcp: treatment.mcp,
			toolSurface: surface,
		};
	});

	return {
		recordType: 'manifest',
		schemaVersion: EXECUTION_SCHEMA_VERSION,
		campaignId,
		claimClass,
		suite: {id: suite.id, version: suite.version, status: suite.status, hash: suite.hash},
		cases: selected.map((testCase) => ({id: testCase.id, hash: caseHashOf(testCase)})),
		harness: HARNESS_VERSION,
		identity,
		identityDigest,
		comparisonDigest,
		model: modelIdentity,
		modelReference: suite.model,
		environment: environmentFacts,
		modelEnvironment:
			environment === null
				? null
				: {id: environment.id, purpose: environment.purpose, hash: environmentHashOf(environment), reference: environment.model.reference},
		revision: suite.revision,
		repetitions,
		randomizationSeed,
		planHash,
		slots: plan,
		plan: {repetitions, randomizationSeed, slotCount: plan.length},
		components: {
			harnessVersion: HARNESS_VERSION,
			eventParserVersion: HARNESS_VERSION,
			toolNormalizerVersion: HARNESS_VERSION,
			workflowClassifierVersion: HARNESS_VERSION,
			graderVersion: HARNESS_VERSION,
		},
		truthAuthority: {kind: 'language-service', reference: 'typescript-language-service'},
		retention: {privacyClass: 'restricted', rawUntil: null},
		equivalence: {
			equivalent: treatmentDifferencesOf(suite.treatments).length === 0,
			differences: treatmentDifferencesOf(suite.treatments),
			sharedConfigHash: identity.sharedConfigHash,
		},
		subject: {
			mode: subject.mode,
			revision: subject.revision,
			declaredRevision: subject.declaredRevision,
			contentManifestHash: subject.contentManifestHash,
			lockFileHash: subject.lockFileHash,
		},
		artifacts: {
			accepted: artifactRefOf(artifacts.get('accepted') ?? null),
			candidate: artifactRefOf(artifacts.get('candidate') ?? null),
		},
		isolation: isolationRecordOf(clientStore, subject.mode),
		campaignStore: campaignStoreRecordOf(clientStore),
		treatments: manifestTreatments,
		startedAt: new Date().toISOString(),
	};
};
