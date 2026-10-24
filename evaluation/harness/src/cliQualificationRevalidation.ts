import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {prepareSurfacesOf, setupEvaluationOf} from './cliEvaluate.ts';
import {artifactsOf, stateRootOutsidePrimaryOf} from './cliSupport.ts';
import {corpusPreflightOf} from './corpusPreflight.ts';
import {contractDigestOf, EVALUATION_CONTRACT, EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {COLD_START_RUNS} from './evaluationPlanning.ts';
import {QUALIFICATION_EXECUTIONS, QUALIFICATION_REPETITIONS, QUALIFICATION_TREATMENT_IDS} from './qualificationContract.ts';
import {commonQualificationInputsOf, type QualificationCommonInputsType} from './qualificationInputs.ts';
import {writeJsonAtomic} from './result.ts';
import {planHashOf, planOf} from './suite.ts';
import {providerMeterSelfCheckOf} from './validityGates.ts';
import {ensureWorkspaces} from './workspaceRestore.ts';

/** One deterministic gate in a model-free qualification revalidation. */
type RevalidationGateType = Readonly<{id: string; passed: boolean; evidence: string; reason: string | null}>;

/** Flags that would contradict the model-free revalidation scope. */
const FORBIDDEN_FLAGS = ['environment', 'budget-ms', 'dry-run', 'model', 'case', 'tag'] as const;

const assertModelFreeOf = (flags: Map<string, string[]>): void => {
	for (const forbidden of FORBIDDEN_FLAGS) {
		if (flags.has(forbidden)) {
			throw new Error(`qualification --revalidate is model-free and does not accept --${forbidden}`);
		}
	}
};

const gatesOf = (
	input: Readonly<{
		inputs: QualificationCommonInputsType;
		artifacts: ReturnType<typeof artifactsOf>;
		surfaces: ReadonlyMap<string, unknown>;
		treatmentIds: readonly string[];
		preflight: Awaited<ReturnType<typeof corpusPreflightOf>>;
		metering: Awaited<ReturnType<typeof providerMeterSelfCheckOf>>;
		isolation: ReturnType<typeof stateRootOutsidePrimaryOf>;
		plan: ReturnType<typeof planOf>;
	}>,
): readonly RevalidationGateType[] => {
	const canonicalIdentity = input.artifacts.get('canonical') ?? null;
	const declaredCanonical = input.inputs.canonicalTreatment.artifact;
	const canonicalPassed =
		canonicalIdentity !== null &&
		declaredCanonical !== null &&
		canonicalIdentity.digest === input.inputs.canonical.digest &&
		declaredCanonical.digest === input.inputs.canonical.digest;
	const planPassed =
		input.plan.length === QUALIFICATION_EXECUTIONS &&
		new Set(input.plan.map((entry) => `${entry.caseId}/${entry.treatment}/${entry.repetition}`)).size === QUALIFICATION_EXECUTIONS &&
		new Set(input.plan.map((entry) => entry.treatment)).size === QUALIFICATION_TREATMENT_IDS.length;
	const surfacePassed = input.surfaces.size === QUALIFICATION_TREATMENT_IDS.length && input.treatmentIds.every((id) => input.surfaces.has(id));

	return [
		{
			id: 'contract',
			passed: EVALUATION_CONTRACT_PIN.digest === contractDigestOf(EVALUATION_CONTRACT),
			evidence: `${EVALUATION_CONTRACT_PIN.id}@${EVALUATION_CONTRACT_PIN.version}`,
			reason: 'the qualification path is not bound to the accepted validity-v2 contract',
		},
		{
			id: 'canonical-artifact',
			passed: canonicalPassed,
			evidence: `${input.inputs.canonical.id}@${input.inputs.canonical.digest}`,
			reason: 'the staged canonical artifact does not match the pinned digest',
		},
		{
			id: 'plan',
			passed: planPassed,
			evidence: `${input.plan.length} unique slot(s), ${QUALIFICATION_TREATMENT_IDS.length} treatment(s), ${QUALIFICATION_REPETITIONS} repetition(s)`,
			reason: 'the frozen 108-slot qualification plan is not intact',
		},
		{
			id: 'request-1-surface',
			passed: surfacePassed,
			evidence: `${input.surfaces.size}/${QUALIFICATION_TREATMENT_IDS.length} treatment(s) exact across ${COLD_START_RUNS} cold start(s)`,
			reason: 'a treatment did not present its declared agent request-1 surface',
		},
		{
			id: 'corpus',
			passed: input.preflight.result === 'pass',
			evidence:
				input.preflight.result === 'pass'
					? `${input.preflight.cases.length} case(s), ${input.preflight.treatments.length} indexed treatment(s)`
					: input.preflight.failures.join('; '),
			reason: 'the corpus preflight did not cover every expected path and semantic declaration',
		},
		{
			id: 'metering',
			passed: input.metering.passed,
			evidence: `${input.metering.requestCount} request(s), settled-exactly-once=${String(input.metering.settledExactlyOnce)}, claim=${input.metering.economicClaim}`,
			reason: 'the loopback provider meter did not settle exactly one request',
		},
		{
			id: 'path-isolation',
			passed: input.isolation.passed,
			evidence: input.isolation.detail,
			reason: input.isolation.detail,
		},
	];
};

/**
 * Revalidates the qualification path against the validity-v2 contract without
 * calling a model.
 *
 * It proves the frozen inputs, the pinned canonical artifact and its staged
 * bytes, the fixed 108-slot plan, agent request 1 for both treatments, corpus
 * coverage, request metering, and path isolation. The all-valid-run aggregation
 * and fail-closed report behavior are proven by the deterministic harness tests.
 *
 * @param flags - Parsed CLI flags.
 */
export const revalidationCommand = async (flags: Map<string, string[]>): Promise<void> => {
	assertModelFreeOf(flags);

	const inputs = commonQualificationInputsOf(flags);
	const plan = planOf(inputs.cases, [...QUALIFICATION_TREATMENT_IDS], QUALIFICATION_REPETITIONS);
	const setup = setupEvaluationOf(flags, {
		treatments: [...QUALIFICATION_TREATMENT_IDS],
		repetitions: QUALIFICATION_REPETITIONS,
		requireFrozen: true,
		model: inputs.suite.model,
		coldStarts: COLD_START_RUNS,
		comparison: false,
	});

	mkdirSync(setup.runDir, {recursive: true});
	ensureWorkspaces(setup.context, setup.treatments);
	const artifacts = artifactsOf(setup.context, setup.treatments);

	process.stderr.write(`revalidation ${inputs.suite.id}: ${COLD_START_RUNS} cold start(s) per treatment\n`);

	const {surfaces} = await prepareSurfacesOf(setup);
	const preflight = await corpusPreflightOf({context: setup.context, cases: setup.selected, treatments: setup.treatments});
	const metering = await providerMeterSelfCheckOf();
	const isolation = stateRootOutsidePrimaryOf();

	writeJsonAtomic(path.join(setup.runDir, 'preflight.json'), preflight, true);

	const gates = gatesOf({
		inputs,
		artifacts,
		surfaces,
		treatmentIds: setup.treatments.map((treatment) => treatment.id),
		preflight,
		metering,
		isolation,
		plan,
	}).map((gate) => ({...gate, reason: gate.passed ? null : gate.reason}));
	const passed = gates.every((gate) => gate.passed);
	const record = {
		recordType: 'qualification-revalidation',
		schemaVersion: 1,
		claimClass: 'validity-only',
		releaseAuthority: false,
		frontierReleaseGate: 'unaffected',
		generatedAt: new Date().toISOString(),
		contract: EVALUATION_CONTRACT_PIN,
		suite: {id: inputs.suite.id, version: inputs.suite.version, hash: inputs.suite.hash},
		revision: inputs.suite.revision,
		canonical: {id: inputs.canonical.id, version: inputs.canonical.version, digest: inputs.canonical.digest},
		plan: {
			caseCount: inputs.cases.length,
			treatments: [...QUALIFICATION_TREATMENT_IDS],
			repetitions: QUALIFICATION_REPETITIONS,
			executions: plan.length,
			hash: planHashOf(plan),
		},
		requestOne: {coldStarts: COLD_START_RUNS, treatments: setup.treatments.map((treatment) => treatment.id)},
		gates,
		passed,
		note: 'model-free revalidation of the qualification path; no model was called and no qualification verdict is issued',
	};
	const file = path.join(setup.runDir, 'revalidation.json');

	writeJsonAtomic(file, record, true);

	for (const gate of gates) {
		process.stdout.write(`${gate.passed ? 'PASS' : 'FAIL'} ${gate.id} (${gate.evidence})\n`);
	}

	process.stdout.write(`record ${file}\n`);

	if (!passed) {
		throw new Error(
			`qualification path revalidation failed: ${gates
				.filter((gate) => !gate.passed)
				.map((gate) => gate.id)
				.join(', ')}`,
		);
	}
};
