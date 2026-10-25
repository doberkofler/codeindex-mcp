import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {evaluateCommand, type EvaluationOptionsType, type EvaluationRunType} from './cliEvaluate.ts';
import {evaluationRoot, evaluationStateRoot, flagOf, manifestPathOf, primaryCheckout} from './cliSupport.ts';
import {TARIFF_SNAPSHOT} from './economicContract.ts';
import {exposureReportOf} from './exposureAnalysis.ts';
import {coreQueryEvidenceOf, type ExposureCoreQueryType} from './exposureCore.ts';
import {exposureDesignOf, type ExposureDesignType} from './exposureDesign.ts';
import {exposurePlanOf, type ExposurePlanType} from './exposurePlan.ts';
import {type ExecutionProviderMeterType} from './executionMeter.ts';
import {hashOf} from './hash.ts';
import {loadHostedReference, type HostedReferenceType} from './hostedReference.ts';
import {writeJsonAtomic} from './result.ts';
import {loadSuite, suiteWithModelOf} from './suite.ts';
import {type CaseType} from './schema.ts';

const EXPOSURE_COLD_STARTS = 20;
const OPENCODE_COMMAND = 'opencode';
const PROVIDER_UPSTREAMS: Readonly<Record<string, string>> = {deepseek: 'https://api.deepseek.com'};

type ExposureInputsType = Readonly<{
	flags: Map<string, string[]>;
	cleanFlags: Map<string, string[]>;
	design: ExposureDesignType;
	hosted: HostedReferenceType;
	suite: ReturnType<typeof loadSuite>['suite'];
	cases: readonly CaseType[];
	plan: ExposurePlanType;
	coreQuery: ExposureCoreQueryType;
	coreQueryFile: string;
}>;

const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as unknown;
	} catch (error) {
		throw new Error(`unable to read exposure design at ${file}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
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
	const suite = requiredFlagOf(flags, 'suite');
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

const assertFrozenProductionOf = (design: ExposureDesignType): void => {
	const file = path.resolve(evaluationRoot, design.frozenProduction.certification);
	const digest = hashOf(readJson(file));

	if (digest !== design.frozenProduction.certificationDigest) {
		throw new Error(`frozen certification record ${file} does not match the design digest`);
	}
};

const assertTariffOf = (design: ExposureDesignType): void => {
	if (design.tariff.id !== TARIFF_SNAPSHOT.id || design.tariff.source !== TARIFF_SNAPSHOT.source || design.tariff.retrievedAt !== TARIFF_SNAPSHOT.retrievedAt) {
		throw new Error('exposure design tariff does not match the frozen contract tariff');
	}

	if (design.tariff.digest !== hashOf(TARIFF_SNAPSHOT)) {
		throw new Error('exposure design tariff digest does not match the frozen contract tariff');
	}
};

const assertTreatmentsOf = (design: ExposureDesignType, suite: ReturnType<typeof loadSuite>['suite']): void => {
	const direct = suite.treatments.find((treatment) => treatment.id === 'direct-mcp');
	const wrapped = suite.treatments.find((treatment) => treatment.id === 'code-mode');

	if (direct === undefined || wrapped === undefined || suite.treatments.length !== 2) {
		throw new Error('exposure suite must declare exactly direct-mcp and code-mode');
	}

	for (const treatment of [direct, wrapped]) {
		if (treatment.ordinaryTools.join('\u0000') !== design.ordinaryTools.join('\u0000')) {
			throw new Error(`exposure design ordinary tools do not match ${treatment.id}`);
		}

		if (treatment.artifact?.id !== design.artifact.id || treatment.artifact.digest !== design.artifact.digest) {
			throw new Error(`exposure design artifact does not match ${treatment.id}`);
		}
	}

	if (direct.codeMode !== 'absent' || direct.mcp?.codemode !== false) {
		throw new Error('direct-mcp treatment must present native MCP tools directly');
	}

	if (wrapped.codeMode !== 'present' || wrapped.mcp?.codemode !== true) {
		throw new Error('code-mode treatment must present the artifact through Code Mode');
	}
};

const suiteForOf = (design: ExposureDesignType, hosted: HostedReferenceType, loaded: ReturnType<typeof loadSuite>): ReturnType<typeof loadSuite>['suite'] => {
	if (loaded.suite.id !== design.suite.id || loaded.suite.version !== design.suite.version) {
		throw new Error(
			`exposure design names ${design.suite.id}@${design.suite.version}, but ${design.suite.path} declares ${loaded.suite.id}@${loaded.suite.version}`,
		);
	}

	if (loaded.suite.status !== 'frozen') {
		throw new Error(`suite ${loaded.suite.id} must be frozen for an exposure comparison`);
	}

	const suite = suiteWithModelOf(loaded.suite, loaded.cases, hosted.reference);

	if (suite.hash !== design.suite.hash) {
		throw new Error(`exposure design pins suite hash ${design.suite.hash}, but the loaded suite hashes to ${suite.hash}`);
	}

	if (suite.revision !== design.suite.revision) {
		throw new Error(`exposure design pins revision ${design.suite.revision}, but the suite pins ${suite.revision}`);
	}

	return suite;
};

const assertCasesOf = (design: ExposureDesignType, cases: readonly CaseType[]): void => {
	if (cases.map((testCase) => testCase.id).join('\u0000') !== design.cases.map((testCase) => testCase.id).join('\u0000')) {
		throw new Error('exposure design cases must equal the frozen suite cases in order');
	}

	for (const [index, testCase] of cases.entries()) {
		const frozen = design.cases[index];

		if (frozen === undefined || frozen.class !== testCase.class) {
			throw new Error(`exposure case ${testCase.id} class does not match the frozen suite`);
		}
	}
};

const assertModelOf = (design: ExposureDesignType, hosted: HostedReferenceType): void => {
	if (hosted.provider !== design.model.provider || hosted.modelId !== design.model.modelId || hosted.reference !== design.model.reference) {
		throw new Error('exposure design model does not match the hosted reference');
	}

	if (hosted.runtime.opencode !== design.model.runtime) {
		throw new Error(`exposure design pins OpenCode ${design.model.runtime}, but the hosted reference pins ${hosted.runtime.opencode}`);
	}

	if (hashOf(hosted.generation) !== hashOf(design.model.generation)) {
		throw new Error('exposure design generation settings do not match the hosted reference');
	}
};

const inputsOf = (flags: Map<string, string[]>): ExposureInputsType => {
	const design = exposureDesignOf(readJson(path.resolve(evaluationRoot, requiredFlagOf(flags, 'design'))));
	const cleanFlags = cleanFlagsOf(flags);
	const hosted = loadHostedReference(manifestPathOf(flags, 'hosted-reference'));
	const loaded = loadSuite(path.resolve(evaluationRoot, design.suite.path));
	const suite = suiteForOf(design, hosted, loaded);

	assertCasesOf(design, loaded.cases);
	assertModelOf(design, hosted);
	assertTreatmentsOf(design, suite);
	assertTariffOf(design);
	assertFrozenProductionOf(design);

	if (design.route.path !== design.route.plan) {
		throw new Error('exposure design route path and plan must name the same complete-route plan');
	}

	const routePlanFile = path.resolve(evaluationRoot, design.route.plan);

	if (hashOf(readJson(routePlanFile)) !== design.route.planHash) {
		throw new Error(`exposure design route plan ${routePlanFile} does not match the pinned plan hash`);
	}

	const coreQueryFile = path.resolve(evaluationRoot, requiredFlagOf(flags, 'route-report'));
	const coreQuery = coreQueryEvidenceOf({reportPath: coreQueryFile, design});
	const plan = exposurePlanOf(design.cases, design.repetitions, design.seed);
	const plannedExecutions = design.cases.length * design.repetitions * 2;

	if (plannedExecutions !== plan.plan.length) {
		throw new Error(`exposure plan produced ${plan.plan.length} executions, expected ${plannedExecutions}`);
	}

	if (plannedExecutions > design.budget.maxExecutions) {
		throw new Error(`exposure plan plans ${plannedExecutions} executions, above the frozen budget of ${design.budget.maxExecutions}`);
	}

	return {flags, cleanFlags, design, hosted, suite, cases: loaded.cases, plan, coreQuery, coreQueryFile};
};

const printDryRunOf = (inputs: ExposureInputsType): void => {
	const planned = inputs.design.cases.length * inputs.design.repetitions * 2;

	process.stderr.write(
		`exposure ${inputs.design.id}: ${inputs.design.cases.length} case(s) x ${inputs.design.repetitions} pair(s) x 2 arms = ${planned} execution(s), ${EXPOSURE_COLD_STARTS} cold start(s) per treatment, budget ${inputs.design.budget.maxExecutions} execution(s) / ${inputs.design.budget.maxProviderCostUsd} USD\n`,
	);
	process.stderr.write(`core-query ${inputs.coreQuery.state} from ${path.relative(evaluationRoot, inputs.coreQueryFile)}\n`);

	for (const entry of inputs.plan.plan) {
		process.stderr.write(`  ${entry.caseId} ${entry.treatment} rep-${entry.repetition}\n`);
	}
};

const optionsOf = (inputs: ExposureInputsType): EvaluationOptionsType => ({
	treatments: ['direct-mcp', 'code-mode'],
	repetitions: inputs.design.repetitions,
	caseIds: inputs.cases.map((testCase) => testCase.id),
	hostedReference: inputs.hosted,
	requireFrozen: true,
	model: inputs.hosted.reference,
	claimClass: 'hosted-model-scoped',
	comparison: false,
	coldStarts: EXPOSURE_COLD_STARTS,
	budgetMs: inputs.design.budget.maxWallClockMs,
	providerMeter: providerMeterOf(inputs.flags, inputs.hosted.provider, inputs.hosted.modelId),
	plan: inputs.plan.plan,
});

const assertBudgetOf = (run: EvaluationRunType, design: ExposureDesignType): void => {
	const observedCost = run.results.reduce((total, result) => total + (result.providerCost?.state === 'exact' ? (result.providerCost.totalUsd ?? 0) : 0), 0);

	if (run.results.length > design.budget.maxExecutions) {
		throw new Error(`exposure comparison stored ${run.results.length} executions, above the frozen budget of ${design.budget.maxExecutions}`);
	}

	if (observedCost > design.budget.maxProviderCostUsd) {
		throw new Error(`exposure provider cost ${observedCost} USD exceeds the frozen budget of ${design.budget.maxProviderCostUsd} USD`);
	}

	if (run.budget?.exceeded === true) {
		throw new Error(`exposure wall-clock budget of ${design.budget.maxWallClockMs} ms was exceeded`);
	}
};

const executeExposureOf = async (inputs: ExposureInputsType): Promise<Readonly<{run: EvaluationRunType; outputDir: string}>> => {
	const outputDir = path.join(evaluationStateRoot, 'results', 'exposure', `${inputs.design.id}-${inputs.design.digest.slice(0, 16)}`);

	writeJsonAtomic(path.join(outputDir, 'design.json'), {design: inputs.design, plan: inputs.plan}, true);
	writeJsonAtomic(path.join(outputDir, 'core-query.json'), inputs.coreQuery, true);

	const run = await evaluateCommand(inputs.cleanFlags, optionsOf(inputs));

	if (run === null) {
		throw new Error('exposure comparison returned no result');
	}

	assertBudgetOf(run, inputs.design);

	return {run, outputDir};
};

/**
 * Runs the frozen paired direct-MCP/Code-Mode exposure comparison.
 *
 * Both arms load the same artifact, ordinary tools, cases, model, and client
 * runtime. Each arm must prove its exact agent request-1 surface after MCP
 * readiness, and every provider request must reconcile before a recommendation
 * is recorded. The record is post-certification evidence and never re-grades
 * EVAL-037.
 *
 * @param flags - Parsed CLI flags.
 */
export const exposureCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = inputsOf(flags);

	if (flags.has('dry-run')) {
		printDryRunOf(inputs);

		return;
	}

	const observedRuntime = observedRuntimeOf();

	if (observedRuntime !== inputs.design.model.runtime) {
		throw new Error(`exposure design pins OpenCode ${inputs.design.model.runtime}, but the measured runtime is ${observedRuntime}`);
	}

	const {run, outputDir} = await executeExposureOf(inputs);
	const report = exposureReportOf({design: inputs.design, plan: inputs.plan, runs: run.results, coreQuery: inputs.coreQuery});

	writeJsonAtomic(path.join(outputDir, 'exposure.json'), report, true);

	const cost = report.metrics.totalTaskCostUsd;

	process.stdout.write(
		`exposure ${report.decision.recommendation.toUpperCase()} action=${report.decision.action} executions=${report.reliability.storedExecutions}/${report.plan.plannedExecutions} valid=${report.reliability.validExecutions} cost-ratio=${String(cost.ratio.value ?? 'n/a')} upper=${String(cost.oneSidedUpper95 ?? 'n/a')} correctness=${report.correctness.gate.passed ? 'pass' : 'fail'} core=${report.coreQuery.state}\n`,
	);
	process.stdout.write(`reason ${report.decision.reason}\n`);
	process.stdout.write(`record ${path.join(outputDir, 'exposure.json')}\n`);

	if (report.reliability.invalidExecutions > 0 || report.reliability.storedExecutions !== report.plan.plannedExecutions) {
		throw new Error(
			`exposure comparison recorded ${report.reliability.invalidExecutions} invalid execution(s) and ${report.reliability.storedExecutions}/${report.plan.plannedExecutions} stored slot(s)`,
		);
	}

	if (report.decision.action === 'blocked') {
		throw new Error(`exposure comparison is blocked: ${report.decision.reason}`);
	}
};
