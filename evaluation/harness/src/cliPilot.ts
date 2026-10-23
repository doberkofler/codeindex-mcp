import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pilotReportOf} from './pilotAnalysis.ts';
import {pilotDesignOf, type PilotDesignType} from './pilotDesign.ts';
import {pilotPlanOf, type PilotPlanType} from './pilotPlan.ts';
import {evaluateCommand, type EvaluationOptionsType, type EvaluationRunType} from './cliEvaluate.ts';
import {evaluationRoot, evaluationStateRoot, flagOf, manifestPathOf, primaryCheckout} from './cliSupport.ts';
import {type ContractPinType, EVALUATION_CONTRACT, EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {type ExecutionProviderMeterType} from './executionMeter.ts';
import {loadHostedReference, type HostedReferenceType} from './hostedReference.ts';
import {writeJsonAtomic} from './result.ts';
import {loadSuite, suiteWithModelOf} from './suite.ts';
import {type CaseType} from './schema.ts';

/** Deterministic cold starts required before the first hosted pilot call. */
const PILOT_COLD_STARTS = 20;

/** Executable whose version is pinned by the hosted reference. */
const OPENCODE_COMMAND = 'opencode';

/** Upstream endpoints for providers the pilot command knows. */
const PROVIDER_UPSTREAMS: Readonly<Record<string, string>> = {deepseek: 'https://api.deepseek.com'};

type PilotInputsType = Readonly<{
	flags: Map<string, string[]>;
	cleanFlags: Map<string, string[]>;
	design: PilotDesignType;
	hosted: HostedReferenceType;
	suite: ReturnType<typeof loadSuite>['suite'];
	cases: readonly CaseType[];
	plan: PilotPlanType;
	contract: ContractPinType;
}>;

const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as unknown;
	} catch (error) {
		throw new Error(`unable to read pilot design at ${file}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
	}
};

const requiredFlagOf = (flags: Map<string, string[]>, name: string): string => {
	const value = flagOf(flags, name);

	if (value === undefined || value === 'true') {
		throw new Error(`--${name} is required`);
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

	if (flags.has('resume')) {
		clean.set('resume', ['true']);
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

const assertDesignThresholdsOf = (design: PilotDesignType): void => {
	if (design.contract.digest !== EVALUATION_CONTRACT_PIN.digest) {
		throw new Error('pilot design is not bound to the accepted validity-v2 contract');
	}

	if (design.thresholds.costRatioTarget !== EVALUATION_CONTRACT.cost.targetRatio) {
		throw new Error(`pilot cost ratio target ${design.thresholds.costRatioTarget} differs from the frozen contract ${EVALUATION_CONTRACT.cost.targetRatio}`);
	}

	if (design.thresholds.nonInferiorityMargin !== EVALUATION_CONTRACT.correctness.nonInferiorityMargin) {
		throw new Error(
			`pilot correctness margin ${design.thresholds.nonInferiorityMargin} differs from the frozen contract ${EVALUATION_CONTRACT.correctness.nonInferiorityMargin}`,
		);
	}

	if (design.thresholds.confidence !== EVALUATION_CONTRACT.cost.confidence) {
		throw new Error(`pilot confidence ${design.thresholds.confidence} differs from the frozen contract ${EVALUATION_CONTRACT.cost.confidence}`);
	}

	if (design.thresholds.falseAbsenceTolerance !== EVALUATION_CONTRACT.correctness.falseAbsenceTolerance) {
		throw new Error('pilot false-absence tolerance differs from the frozen contract');
	}
};

const inputsOf = (flags: Map<string, string[]>): PilotInputsType => {
	const designPath = requiredFlagOf(flags, 'design');
	const design = pilotDesignOf(readJson(path.resolve(evaluationRoot, designPath)));
	const cleanFlags = cleanFlagsOf(flags);
	const hosted = loadHostedReference(manifestPathOf(flags, 'hosted-reference'));
	const loaded = loadSuite(path.resolve(evaluationRoot, design.suite.path));

	if (loaded.suite.id !== design.suite.id) {
		throw new Error(`pilot design names suite ${design.suite.id}, but ${design.suite.path} declares ${loaded.suite.id}`);
	}

	if (loaded.suite.version !== design.suite.version) {
		throw new Error(`pilot design pins suite version ${design.suite.version}, but ${design.suite.path} declares ${loaded.suite.version}`);
	}

	if (loaded.suite.status !== 'frozen') {
		throw new Error(`suite ${loaded.suite.id} must be frozen for a development pilot`);
	}

	const suite = suiteWithModelOf(loaded.suite, loaded.cases, hosted.reference);

	if (suite.hash !== design.suite.hash) {
		throw new Error(`pilot design pins suite hash ${design.suite.hash}, but the loaded suite hashes to ${suite.hash}`);
	}

	const caseIds = loaded.cases.map((testCase) => testCase.id);

	if (caseIds.join('\u0000') !== design.cases.map((testCase) => testCase.id).join('\u0000')) {
		throw new Error('pilot design cases must equal the frozen suite cases in order');
	}

	for (const [index, testCase] of loaded.cases.entries()) {
		const frozen = design.cases[index];

		if (frozen === undefined || frozen.class !== testCase.class) {
			throw new Error(`pilot case ${testCase.id} class does not match the frozen suite`);
		}
	}

	if (hosted.provider !== design.model.provider || hosted.modelId !== design.model.modelId || hosted.reference !== design.model.reference) {
		throw new Error('pilot design model does not match the hosted reference');
	}

	if (hosted.runtime.opencode !== design.model.runtime) {
		throw new Error(`pilot design pins OpenCode ${design.model.runtime}, but the hosted reference pins ${hosted.runtime.opencode}`);
	}

	assertDesignThresholdsOf(design);

	const plan = pilotPlanOf(design.cases, design.repetitions, design.seed);
	const plannedExecutions = design.cases.length * design.repetitions * 2;

	if (plannedExecutions !== plan.plan.length) {
		throw new Error(`pilot plan produced ${plan.plan.length} executions, expected ${plannedExecutions}`);
	}

	if (plannedExecutions > design.budget.maxExecutions) {
		throw new Error(`pilot plan plans ${plannedExecutions} executions, above the frozen budget of ${design.budget.maxExecutions}`);
	}

	return {
		flags,
		cleanFlags,
		design,
		hosted,
		suite,
		cases: loaded.cases,
		plan,
		contract: {
			id: EVALUATION_CONTRACT.id,
			version: EVALUATION_CONTRACT.version,
			digest: EVALUATION_CONTRACT_PIN.digest,
			frozenAt: EVALUATION_CONTRACT.frozenAt,
		},
	};
};

const printDryRunOf = (inputs: PilotInputsType): void => {
	const planned = inputs.cases.length * inputs.design.repetitions * 2;

	process.stderr.write(
		`pilot ${inputs.design.id}: ${inputs.cases.length} case(s) x ${inputs.design.repetitions} pair(s) x 2 arms = ${planned} execution(s), ${PILOT_COLD_STARTS} cold start(s) per treatment, budget ${inputs.design.budget.maxExecutions} execution(s) / ${inputs.design.budget.maxProviderCostUsd} USD\n`,
	);

	for (const entry of inputs.plan.plan) {
		process.stderr.write(`  ${entry.caseId} ${entry.treatment} rep-${entry.repetition}\n`);
	}
};

const optionsOf = (inputs: PilotInputsType): EvaluationOptionsType => ({
	treatments: ['no-index', 'candidate'],
	repetitions: inputs.design.repetitions,
	caseIds: inputs.cases.map((testCase) => testCase.id),
	hostedReference: inputs.hosted,
	requireFrozen: true,
	model: inputs.hosted.reference,
	claimClass: 'hosted-model-scoped',
	// The Q2 report expects the fixed three-treatment suite. A two-arm
	// development pilot writes its own paired report instead.
	comparison: false,
	coldStarts: PILOT_COLD_STARTS,
	budgetMs: inputs.design.budget.maxWallClockMs,
	providerMeter: providerMeterOf(inputs.flags, inputs.hosted.provider, inputs.hosted.modelId),
	plan: inputs.plan.plan,
});

const assertBudgetOf = (run: EvaluationRunType, design: PilotDesignType): void => {
	const observedCost = run.results.reduce((total, result) => total + (result.providerCost?.state === 'exact' ? (result.providerCost.totalUsd ?? 0) : 0), 0);

	if (run.results.length > design.budget.maxExecutions) {
		throw new Error(`pilot stored ${run.results.length} executions, above the frozen budget of ${design.budget.maxExecutions}`);
	}

	if (observedCost > design.budget.maxProviderCostUsd) {
		throw new Error(`pilot provider cost ${observedCost} USD exceeds the frozen budget of ${design.budget.maxProviderCostUsd} USD`);
	}

	if (run.budget?.exceeded === true) {
		throw new Error(`pilot wall-clock budget of ${design.budget.maxWallClockMs} ms was exceeded`);
	}
};

const executePilotOf = async (inputs: PilotInputsType): Promise<Readonly<{run: EvaluationRunType; pilotDir: string}>> => {
	const pilotDir = path.join(evaluationStateRoot, 'results', 'pilot', `${inputs.design.id}-${inputs.design.digest.slice(0, 16)}`);

	writeJsonAtomic(
		path.join(pilotDir, 'design.json'),
		{
			design: inputs.design,
			plan: inputs.plan,
			contract: inputs.contract,
			suite: {id: inputs.suite.id, version: inputs.suite.version, hash: inputs.suite.hash},
		},
		true,
	);

	const run = await evaluateCommand(inputs.cleanFlags, optionsOf(inputs));

	if (run === null) {
		throw new Error('pilot execution returned no result');
	}

	assertBudgetOf(run, inputs.design);

	return {run, pilotDir};
};

/**
 * Runs a budgeted paired no-index/candidate development pilot.
 *
 * The frozen design pins cases, weights, model, exposure, repetitions, budget,
 * thresholds, holdout reservation, and breadth selection before the first
 * provider request. The report preserves request trajectories and classifies
 * request-1 availability, index contribution, authoritative stop behavior,
 * ordinary fallback, and complete cost vectors. The decision is closed evidence
 * and never a release authorization.
 *
 * @param flags - Parsed CLI flags.
 */
export const pilotCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = inputsOf(flags);

	if (flags.has('dry-run')) {
		printDryRunOf(inputs);

		return;
	}

	const observedRuntime = observedRuntimeOf();

	if (observedRuntime !== inputs.design.model.runtime) {
		throw new Error(`pilot design pins OpenCode ${inputs.design.model.runtime}, but the measured runtime is ${observedRuntime}`);
	}

	const {run, pilotDir} = await executePilotOf(inputs);
	const report = pilotReportOf({runs: run.results, design: inputs.design});

	writeJsonAtomic(path.join(pilotDir, 'pilot.json'), report, true);

	process.stdout.write(
		`pilot ${report.decision.decision.toUpperCase()} executions=${report.plan.storedExecutions}/${report.plan.plannedExecutions} valid=${report.plan.validExecutions} cost-ratio=${String(report.economic.cost.ratio.value ?? 'n/a')} cost-upper=${String(report.economic.cost.oneSidedUpper95 ?? 'n/a')} correctness=${report.economic.correctness.gate.passed ? 'pass' : 'fail'}\n`,
	);
	process.stdout.write(`reason ${report.decision.reason}\n`);
	process.stdout.write(`record ${path.join(pilotDir, 'pilot.json')}\n`);

	if (report.plan.invalidExecutions > 0) {
		throw new Error(`pilot recorded ${report.plan.invalidExecutions} invalid execution(s); see the retained causes`);
	}
};
