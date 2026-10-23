import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {type AaCalibrationType} from './aaTypes.ts';
import {aaCalibrationOf} from './aaAnalysis.ts';
import {aaPlanOf, type AaPlanType} from './aaPlan.ts';
import {artifactRefOf} from './artifact.ts';
import {corpusPreflightOf, type CorpusPreflightType} from './corpusPreflight.ts';
import {EVALUATION_CONTRACT, EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {loadHostedReference, type HostedReferenceType} from './hostedReference.ts';
import {hashOf} from './hash.ts';
import {writeJsonAtomic} from './result.ts';
import {evaluateCommand, prepareSurfacesOf, setupEvaluationOf, type EvaluationOptionsType, type EvaluationRunType} from './cliEvaluate.ts';
import {artifactsOf, allOf, evaluationRoot, evaluationStateRoot, flagOf, manifestPathOf, primaryCheckout} from './cliSupport.ts';
import {type ExecutionProviderMeterType} from './executionMeter.ts';
import {loadSuite, selectCases, suiteWithModelOf} from './suite.ts';
import {type CaseType} from './schema.ts';
import {type DeterministicValidityType, deterministicValidityOf, providerMeterSelfCheckOf, validitySmokeOf, type ValiditySmokeType} from './validityGates.ts';
import {ensureWorkspaces} from './workspaceRestore.ts';

/** Deterministic cold starts required before the first hosted validity call. */
const VALIDITY_COLD_STARTS = 20;

/** Executable whose version is measured against the pinned runtime. */
const OPENCODE_COMMAND = 'opencode';

/** Upstream endpoint for providers the validity command knows. */
const PROVIDER_UPSTREAMS: Readonly<Record<string, string>> = {deepseek: 'https://api.deepseek.com'};

type ValidityInputsType = Readonly<{
	flags: Map<string, string[]>;
	cleanFlags: Map<string, string[]>;
	suite: ReturnType<typeof suiteWithModelOf>;
	hosted: HostedReferenceType;
	aaCases: readonly CaseType[];
	smokeCase: CaseType;
	repetitions: number;
	seed: string;
	aaPlan: AaPlanType;
	providerMeter: ExecutionProviderMeterType;
	budgetMs: number | undefined;
}>;

type DeterministicRunType = Readonly<{
	setup: ReturnType<typeof setupEvaluationOf>;
	artifacts: ReturnType<typeof artifactsOf>;
	preflight: CorpusPreflightType;
	deterministic: DeterministicValidityType;
	validityDir: string;
	treatmentContexts: Awaited<ReturnType<typeof prepareSurfacesOf>>['treatmentContexts'];
}>;

const integerFlagOf = (flags: Map<string, string[]>, name: string, fallback: number): number => {
	const raw = flagOf(flags, name);

	if (raw === undefined) {
		return fallback;
	}

	const value = Number(raw);

	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`--${name} must be a positive integer`);
	}

	return value;
};

const budgetOf = (flags: Map<string, string[]>): number | undefined => {
	const raw = flagOf(flags, 'budget-ms');

	if (raw === undefined) {
		return undefined;
	}

	const value = Number(raw);

	if (!Number.isInteger(value) || value <= 0) {
		throw new Error('--budget-ms must be a positive integer');
	}

	return value;
};

const cleanFlagsOf = (flags: Map<string, string[]>): Map<string, string[]> => {
	const suite = flagOf(flags, 'suite');

	if (suite === undefined || suite === 'true') {
		throw new Error('--suite is required');
	}

	const clean = new Map<string, string[]>([['suite', [suite]]]);
	const campaignStore = flagOf(flags, 'campaign-store');

	if (campaignStore !== undefined) {
		clean.set('campaign-store', [campaignStore]);
	}

	return clean;
};

const providerMeterOf = (flags: Map<string, string[]>, provider: string, modelId: string): ExecutionProviderMeterType => {
	const upstream = flagOf(flags, 'provider-upstream') ?? PROVIDER_UPSTREAMS[provider];

	if (upstream === undefined || upstream === 'true') {
		throw new Error(`--provider-upstream is required for provider "${provider}"`);
	}

	const authName = flagOf(flags, 'provider-auth-env');
	const auth = authName === undefined || authName === 'true' ? undefined : process.env[authName];

	if (authName !== undefined && authName !== 'true' && auth === undefined) {
		throw new Error(`--provider-auth-env names ${authName}, but that environment variable is not set`);
	}

	return {
		upstreamBaseUrl: upstream,
		provider,
		modelId,
		forbiddenPaths: [primaryCheckout],
		...(auth === undefined ? {} : {upstreamHeaders: {authorization: `Bearer ${auth}`}}),
	};
};

const observedRuntimeOf = (): string => {
	const version = execFileSync(OPENCODE_COMMAND, ['--version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});

	return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u.exec(version)?.[0] ?? 'unknown';
};

const outsidePrimaryOf = (): Readonly<{passed: boolean; detail: string}> => {
	const relative = path.relative(primaryCheckout, evaluationStateRoot);
	const outside = relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative));

	return {
		passed: outside,
		detail: outside
			? `state root ${evaluationStateRoot} is outside primary checkout ${primaryCheckout}`
			: `state root resolves inside primary checkout ${primaryCheckout}`,
	};
};

const smokeCaseOf = (flags: Map<string, string[]>, cases: readonly CaseType[]): CaseType => {
	const requested = flagOf(flags, 'smoke-case');
	const id = requested ?? cases.find((testCase) => testCase.class === 'semantic')?.id ?? cases[0]?.id;
	const testCase = cases.find((item) => item.id === id);

	if (testCase === undefined) {
		throw new Error(id === undefined ? 'validity calibration selects no smoke case' : `unknown smoke case ${id}`);
	}

	return testCase;
};

const inputsOf = (flags: Map<string, string[]>): ValidityInputsType => {
	const cleanFlags = cleanFlagsOf(flags);
	const hosted = loadHostedReference(manifestPathOf(flags, 'hosted-reference'));
	const loaded = loadSuite(path.resolve(evaluationRoot, flagOf(flags, 'suite') ?? ''));

	if (loaded.suite.status !== 'frozen') {
		throw new Error(`suite ${loaded.suite.id} must be frozen for validity calibration`);
	}

	const suite = suiteWithModelOf(loaded.suite, loaded.cases, hosted.reference);
	const aaCases = selectCases(loaded.cases, {caseIds: allOf(flags, 'aa-case')});
	const smokeCase = smokeCaseOf(flags, aaCases);
	const repetitions = integerFlagOf(flags, 'aa-repetitions', 2);

	if (repetitions < 2) {
		throw new Error('--aa-repetitions must be at least 2 so within-case variance is estimable');
	}

	const seed = hashOf({
		purpose: 'aa-calibration',
		suite: suite.hash,
		model: hosted.reference,
		hosted: hashOf(hosted),
		repetitions,
		cases: aaCases.map((testCase) => testCase.id),
	});

	return {
		flags,
		cleanFlags,
		suite,
		hosted,
		aaCases,
		smokeCase,
		repetitions,
		seed,
		aaPlan: aaPlanOf(aaCases, repetitions, seed),
		providerMeter: providerMeterOf(flags, hosted.provider, hosted.modelId),
		budgetMs: budgetOf(flags),
	};
};

const printDryRunOf = (inputs: ValidityInputsType): void => {
	process.stderr.write(
		`validity ${inputs.suite.id} v${inputs.suite.version}: ${VALIDITY_COLD_STARTS} cold start(s) per treatment, smoke ${inputs.smokeCase.id}, A/A ${inputs.aaCases.length} case(s) x ${inputs.repetitions} pair(s) x 2 arms = ${inputs.aaPlan.plan.length} execution(s)\n`,
	);

	for (const entry of inputs.aaPlan.plan) {
		process.stderr.write(`  aa ${entry.caseId} rep-${entry.repetition}\n`);
	}
};

const assertRuntimeOf = (inputs: ValidityInputsType, observedRuntime: string): void => {
	if (observedRuntime !== inputs.hosted.runtime.opencode) {
		throw new Error(`validity reference ${inputs.hosted.id} pins OpenCode ${inputs.hosted.runtime.opencode}, but the measured runtime is ${observedRuntime}`);
	}
};

const semanticFixturesOf = (preflight: CorpusPreflightType, caseIds: readonly string[]): boolean => {
	const selected = new Set(caseIds);

	return (
		preflight.result === 'pass' && preflight.cases.filter((item) => selected.has(item.caseId)).every((item) => item.symbolProbe === null || item.symbolProbe.ok)
	);
};

const deterministicRunOf = async (inputs: ValidityInputsType): Promise<DeterministicRunType> => {
	const options: EvaluationOptionsType = {
		treatments: ['no-index', 'accepted'],
		repetitions: 1,
		caseIds: inputs.aaCases.map((testCase) => testCase.id),
		model: inputs.hosted.reference,
		requireFrozen: true,
		coldStarts: VALIDITY_COLD_STARTS,
		providerMeter: inputs.providerMeter,
	};
	const setup = setupEvaluationOf(inputs.cleanFlags, options);

	ensureWorkspaces(setup.context, setup.treatments);
	const artifacts = artifactsOf(setup.context, setup.treatments);

	process.stderr.write(`validity deterministic gates: ${VALIDITY_COLD_STARTS} cold start(s) per treatment\n`);
	const {surfaces, treatmentContexts} = await prepareSurfacesOf(setup);
	const preflight = await corpusPreflightOf({context: setup.context, cases: setup.selected, treatments: setup.treatments});
	const metering = await providerMeterSelfCheckOf();
	const deterministic = deterministicValidityOf({
		contractAccepted: EVALUATION_CONTRACT_PIN.digest === hashOf(EVALUATION_CONTRACT),
		metering: {
			passed: metering.passed,
			detail: `${metering.requestCount} request(s), settled-exactly-once=${String(metering.settledExactlyOnce)}, claim=${metering.economicClaim}`,
		},
		surface: setup.treatments.map((treatment) => ({
			treatmentId: treatment.id,
			coldStarts: VALIDITY_COLD_STARTS,
			passed: surfaces.has(treatment.id),
			detail: treatment.id,
		})),
		corpus: {
			passed: preflight.result === 'pass',
			detail: preflight.result === 'pass' ? `${preflight.treatments.length} indexed treatment(s)` : preflight.failures.join('; '),
		},
		pathIsolation: outsidePrimaryOf(),
	});
	const validityId = hashOf({suite: inputs.suite.hash, hosted: hashOf(inputs.hosted), deterministic: deterministic.gates, aaSeed: inputs.seed}).slice(0, 16);
	const validityDir = path.join(evaluationStateRoot, 'results', 'validity', `${inputs.suite.id}-${validityId}`);

	writeJsonAtomic(path.join(validityDir, 'preflight.json'), preflight, true);
	writeJsonAtomic(path.join(validityDir, 'deterministic.json'), deterministic, true);

	for (const gate of deterministic.gates) {
		process.stderr.write(`${gate.passed ? 'PASS' : 'FAIL'} ${gate.id} (${gate.evidence})\n`);
	}

	return {setup, artifacts, preflight, deterministic, validityDir, treatmentContexts};
};

const baseOptionsOf = (inputs: ValidityInputsType): EvaluationOptionsType => ({
	model: inputs.hosted.reference,
	requireFrozen: true,
	coldStarts: 1,
	providerMeter: inputs.providerMeter,
	comparison: false,
	...(inputs.budgetMs === undefined ? {} : {budgetMs: inputs.budgetMs}),
});

const runOf = async (flags: Map<string, string[]>, options: EvaluationOptionsType): Promise<EvaluationRunType> => {
	const run = await evaluateCommand(flags, options);

	if (run === null) {
		throw new Error('validity execution returned no result');
	}

	return run;
};

const smokeRunOf = async (inputs: ValidityInputsType, preflight: CorpusPreflightType, requestOneSurfacePassed: boolean): Promise<ValiditySmokeType> => {
	process.stderr.write(`validity smoke ${inputs.smokeCase.id} accepted\n`);
	const run = await runOf(inputs.cleanFlags, {
		...baseOptionsOf(inputs),
		treatments: ['accepted'],
		repetitions: 1,
		caseIds: [inputs.smokeCase.id],
	});

	return validitySmokeOf({
		runs: run.results,
		caseIds: [inputs.smokeCase.id],
		semanticFixturesIndexed: semanticFixturesOf(preflight, [inputs.smokeCase.id]),
		corpusPreflightPassed: preflight.result === 'pass',
		requestOneSurfacePassed,
	});
};

const aaRunOf = async (inputs: ValidityInputsType): Promise<AaCalibrationType> => {
	process.stderr.write(`validity A/A ${inputs.aaCases.length} case(s) x ${inputs.repetitions} pair(s) x 2 no-index arms\n`);
	const run = await runOf(inputs.cleanFlags, {
		...baseOptionsOf(inputs),
		treatments: ['no-index'],
		repetitions: inputs.repetitions * 2,
		caseIds: inputs.aaCases.map((testCase) => testCase.id),
		plan: inputs.aaPlan.plan,
	});

	return aaCalibrationOf({runs: run.results, cases: inputs.aaCases, repetitionsPerCase: inputs.repetitions, seed: inputs.seed, plan: inputs.aaPlan});
};

const reportOf = (
	input: Readonly<{
		inputs: ValidityInputsType;
		observedRuntime: string;
		run: DeterministicRunType;
		smoke: ValiditySmokeType | null;
		aa: AaCalibrationType | null;
	}>,
): Readonly<Record<string, unknown>> => {
	const {inputs, observedRuntime, run, smoke, aa} = input;
	const passed = run.deterministic.passed && smoke?.passed === true && aa?.passed === true;
	const reasons =
		smoke === null || aa === null
			? ['deterministic validity gates failed before the first hosted call']
			: [smoke.reason, aa.labelEffect.equivalence.reason, aa.sampleSize.reason].filter((reason): reason is string => reason !== null);

	return {
		recordType: 'validity-calibration',
		schemaVersion: 1,
		claimClass: 'validity-only',
		efficacyClaim: false,
		releaseAuthority: false,
		generatedAt: new Date().toISOString(),
		suite: {id: inputs.suite.id, version: inputs.suite.version, hash: inputs.suite.hash},
		model: {reference: inputs.hosted.reference, hostedReference: inputs.hosted.id, reportedRuntime: inputs.hosted.runtime.opencode, observedRuntime},
		contract: EVALUATION_CONTRACT_PIN,
		artifacts: {accepted: artifactRefOf(run.artifacts.get('accepted') ?? null)},
		treatmentContexts: Object.fromEntries([...run.treatmentContexts].map(([id, value]) => [id, value.configDigest])),
		deterministic: run.deterministic,
		smoke,
		aa,
		sampleSize: aa?.sampleSize ?? null,
		passed,
		reason: passed ? null : reasons.join('; ') || 'validity calibration did not pass',
	};
};

const writeAndPrintOf = (run: DeterministicRunType, report: Readonly<Record<string, unknown>>): void => {
	writeJsonAtomic(path.join(run.validityDir, 'validity.json'), report, true);
	process.stdout.write(`record ${path.join(run.validityDir, 'validity.json')}\n`);
};

/**
 * Runs deterministic validity gates, a hosted smoke, and a disjoint A/A
 * calibration.
 *
 * The deterministic phase is zero-spend and must pass before any provider call.
 * The hosted smoke and A/A records are validity evidence only; they can never
 * support an efficacy or release claim.
 *
 * @param flags - Parsed CLI flags.
 */
export const validityCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = inputsOf(flags);

	if (flags.has('dry-run')) {
		printDryRunOf(inputs);

		return;
	}

	const observedRuntime = observedRuntimeOf();

	assertRuntimeOf(inputs, observedRuntime);

	const run = await deterministicRunOf(inputs);

	if (!run.deterministic.passed) {
		const report = reportOf({inputs, observedRuntime, run, smoke: null, aa: null});

		writeAndPrintOf(run, report);
		process.stdout.write('validity NOT PASSED\n');
		throw new Error('deterministic validity gates failed; no hosted call was made');
	}

	const surfaceGate = run.deterministic.gates.find((gate) => gate.id === 'request-1-surface')?.passed === true;
	const smoke = await smokeRunOf(inputs, run.preflight, surfaceGate);

	writeJsonAtomic(path.join(run.validityDir, 'smoke.json'), smoke, true);

	const aa = await aaRunOf(inputs);

	writeJsonAtomic(path.join(run.validityDir, 'aa.json'), aa, true);

	const report = reportOf({inputs, observedRuntime, run, smoke, aa});

	writeAndPrintOf(run, report);
	process.stdout.write(
		`validity ${report['passed'] === true ? 'PASSED' : 'NOT PASSED'} smoke=${smoke.passed ? 'pass' : 'fail'} aa-equivalent=${String(aa.labelEffect.equivalence.passed)} aa-pairs=${aa.validPairs}/${aa.pairCount} sample-size=${aa.sampleSize.chosenRepetitions ?? 'undetermined'} executions=${aa.sampleSize.executions ?? 'undetermined'}\n`,
	);

	if (report['passed'] !== true) {
		throw new Error(`validity calibration not passed: ${String(report['reason'])}`);
	}
};
