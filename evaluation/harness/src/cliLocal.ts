import path from 'node:path';
import {assertEnvironmentPurpose, environmentHashOf, loadEnvironmentManifest, type EnvironmentManifestType} from './environment.ts';
import {hashOf} from './hash.ts';
import {
	assertLocalClaimClass,
	LOCAL_CLAIM_CLASS,
	LOCAL_REGRESSION_CASE_COUNT,
	LOCAL_REGRESSION_EXECUTIONS,
	LOCAL_REGRESSION_REPETITIONS,
	LOCAL_REGRESSION_TREATMENT_IDS,
	TARGETED_DIAGNOSTIC_CASE_IDS,
	TARGETED_DIAGNOSTIC_EXECUTIONS,
	TARGETED_DIAGNOSTIC_REPETITIONS,
	TARGETED_DIAGNOSTIC_TREATMENT_IDS,
	type TrackedMetricType,
} from './localContract.ts';
import {targetedDiagnosticReportOf, type TargetedDiagnosticReportType} from './localDiagnostic.ts';
import {localRegressionReportOf, localRegressionSummaryOf} from './localRegression.ts';
import {manifestMetadataOf, allOf, evaluationRoot, flagOf, verifiedEnvironmentOf} from './cliSupport.ts';
import {evaluateCommand, type EvaluationRunType} from './cliEvaluate.ts';
import {writeJsonAtomic} from './result.ts';
import {loadSuite, treatmentIdsOf} from './suite.ts';

/** Default wall-clock budget for the four-execution targeted diagnostic. */
const TARGETED_DIAGNOSTIC_BUDGET_MS = 15 * 60 * 1000;

/** Closed set of metrics either local stage may predeclare. */
const TRACKED_METRICS: readonly TrackedMetricType[] = ['retrievalBytes', 'toolCalls', 'tokens', 'wallTimeMs'];

/** Flags that would change a fixed local plan. */
const FIXED_PLAN_FLAGS = ['case', 'tag', 'treatment', 'repetitions'] as const;

/** Resolved frozen inputs for either local stage. */
type LocalInputsType = Readonly<{
	flags: Map<string, string[]>;
	suite: ReturnType<typeof loadSuite>['suite'];
	cases: ReturnType<typeof loadSuite>['cases'];
	environment: EnvironmentManifestType;
	targetMetric: TrackedMetricType;
}>;

const targetMetricOf = (flags: Map<string, string[]>): TrackedMetricType => {
	const raw = flagOf(flags, 'target-metric');

	if (raw === undefined || raw === 'true') {
		throw new Error(`--target-metric is required (${TRACKED_METRICS.join(', ')})`);
	}

	const metric = TRACKED_METRICS.find((item) => item === raw);

	if (metric === undefined) {
		throw new Error(`--target-metric must be one of ${TRACKED_METRICS.join(', ')}`);
	}

	return metric;
};

const budgetOf = (flags: Map<string, string[]>, fallback?: number): number | undefined => {
	const raw = flagOf(flags, 'budget-ms');

	if (raw === undefined) {
		return fallback;
	}

	const budgetMs = Number(raw);

	if (!Number.isInteger(budgetMs) || budgetMs <= 0) {
		throw new Error('--budget-ms must be a positive integer');
	}

	return budgetMs;
};

const localInputsOf = (flags: Map<string, string[]>): LocalInputsType => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined || suitePath === 'true') {
		throw new Error('--suite is required');
	}

	for (const forbidden of FIXED_PLAN_FLAGS) {
		if (flags.has(forbidden)) {
			throw new Error(`local evaluation does not accept --${forbidden}; the frozen local plan is fixed`);
		}
	}

	const environmentPaths = allOf(flags, 'environment');

	if (environmentPaths.length !== 1) {
		throw new Error('--environment is required exactly once');
	}

	const [environmentPath] = environmentPaths;

	if (environmentPath === undefined || environmentPath === 'true') {
		throw new Error('--environment is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));

	if (suite.status !== 'frozen') {
		throw new Error(`suite ${suite.id} must be frozen for local evaluation`);
	}

	if (cases.length !== LOCAL_REGRESSION_CASE_COUNT) {
		throw new Error(`local evaluation requires the frozen ${LOCAL_REGRESSION_CASE_COUNT}-case suite; suite ${suite.id} declares ${cases.length} case(s)`);
	}

	const treatmentIds = treatmentIdsOf(suite.treatments);

	if (treatmentIds.join(',') !== LOCAL_REGRESSION_TREATMENT_IDS.join(',')) {
		throw new Error(`local evaluation requires treatments ${LOCAL_REGRESSION_TREATMENT_IDS.join(', ')}; suite ${suite.id} declares ${treatmentIds.join(', ')}`);
	}

	const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));

	for (const caseId of TARGETED_DIAGNOSTIC_CASE_IDS) {
		const testCase = byId.get(caseId);

		if (testCase === undefined) {
			throw new Error(`suite ${suite.id} does not contain diagnostic case ${caseId}`);
		}

		if (testCase.class !== 'impact') {
			throw new Error(`diagnostic case ${caseId} must declare class impact`);
		}
	}

	const environment = loadEnvironmentManifest(path.resolve(evaluationRoot, environmentPath));

	assertEnvironmentPurpose(environment, 'calibration');

	return {flags, suite, cases, environment, targetMetric: targetMetricOf(flags)};
};

// Runs the four-execution diagnostic and writes its record beside the results.
const runTargetedDiagnosticOf = async (inputs: LocalInputsType): Promise<Readonly<{run: EvaluationRunType; report: TargetedDiagnosticReportType}> | null> => {
	const {flags, suite, environment, targetMetric} = inputs;

	process.stderr.write(
		`targeted diagnostic ${environment.model.reference}: ${TARGETED_DIAGNOSTIC_CASE_IDS.length} impact case(s) x ${TARGETED_DIAGNOSTIC_TREATMENT_IDS.length} treatment(s) x ${TARGETED_DIAGNOSTIC_REPETITIONS} repetition = ${TARGETED_DIAGNOSTIC_EXECUTIONS} executions\n`,
	);

	const budgetMs = budgetOf(flags, TARGETED_DIAGNOSTIC_BUDGET_MS);
	const run = await evaluateCommand(flags, {
		treatments: [...TARGETED_DIAGNOSTIC_TREATMENT_IDS],
		repetitions: TARGETED_DIAGNOSTIC_REPETITIONS,
		caseIds: [...TARGETED_DIAGNOSTIC_CASE_IDS],
		environment,
		requireFrozen: true,
		model: environment.model.reference,
		claimClass: LOCAL_CLAIM_CLASS,
		comparison: false,
		...(budgetMs === undefined ? {} : {budgetMs}),
	});

	if (run === null) {
		return null;
	}

	const report = targetedDiagnosticReportOf({
		results: run.results,
		suite: {id: suite.id, version: suite.version, hash: suite.hash},
		model: environment.model.reference,
		environment: {id: environment.id, hash: environmentHashOf(environment)},
		targetMetric,
	});

	writeJsonAtomic(path.join(run.runDir, 'targeted-diagnostic.json'), report, true);

	return {run, report};
};

/**
 * Runs the fixed four-execution accepted-versus-candidate diagnostic.
 *
 * The diagnostic is the normal development loop for one MCP interface change.
 * It never starts the full local suite: a blocked result is written and the
 * command fails.
 *
 * @param flags - Parsed CLI flags.
 */
export const localDiagnosticCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = localInputsOf(flags);

	if (!flags.has('dry-run')) {
		process.stderr.write(`environment ${inputs.environment.id} verification\n`);
		await verifiedEnvironmentOf(inputs.environment);
	}

	const result = await runTargetedDiagnosticOf(inputs);

	if (result === null) {
		return;
	}

	const {run, report} = result;

	process.stdout.write(
		`targeted diagnostic ${report.passed ? 'PASSED' : 'BLOCKED'} claim=${report.claimClass} target=${report.targetMetric} executions=${report.executions}/${report.expectedExecutions}\n`,
	);

	for (const [metric, delta] of Object.entries(report.metrics)) {
		process.stdout.write(
			`${metric.padEnd(14)} accepted ${delta.accepted ?? 'unavailable'} candidate ${delta.candidate ?? 'unavailable'} ratio ${delta.ratio === null ? 'n/a' : delta.ratio.toFixed(3)}\n`,
		);
	}

	for (const finding of report.regressions) {
		if (!report.blockingRegressions.includes(finding)) {
			process.stdout.write(`observed ${finding}\n`);
		}
	}

	for (const finding of report.blocking) {
		process.stdout.write(`BLOCKED ${finding}\n`);
	}

	process.stdout.write(`diagnostic ${path.join(run.runDir, 'targeted-diagnostic.json')}\n`);

	if (!report.passed) {
		throw new Error(`targeted diagnostic blocked: ${report.blocking.join('; ')}`);
	}
};

// Builds the fixed full-regression options shared by the real and dry runs.
const regressionOptionsOf = (inputs: LocalInputsType): Parameters<typeof evaluateCommand>[1] => {
	const budgetMs = budgetOf(inputs.flags);

	return {
		treatments: [...LOCAL_REGRESSION_TREATMENT_IDS],
		repetitions: LOCAL_REGRESSION_REPETITIONS,
		environment: inputs.environment,
		requireFrozen: true,
		model: inputs.environment.model.reference,
		claimClass: LOCAL_CLAIM_CLASS,
		comparison: true,
		...(budgetMs === undefined ? {} : {budgetMs}),
	};
};

/**
 * Runs the full 18-case local regression after the targeted diagnostic passes.
 *
 * The local model, environment, suite, target metric, and three paired
 * repetitions are fixed. The record carries the local-model claim class and no
 * release authority, and class-stratified findings require targeted diagnosis
 * whenever a statistically supported regression or gate failure appears.
 *
 * @param flags - Parsed CLI flags.
 */
export const localRegressionCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = localInputsOf(flags);
	const options = regressionOptionsOf(inputs);

	if (!flags.has('dry-run')) {
		process.stderr.write(`environment ${inputs.environment.id} verification\n`);
		await verifiedEnvironmentOf(inputs.environment);
	}

	const diagnostic = await runTargetedDiagnosticOf(inputs);

	if (diagnostic === null) {
		// A dry run still prints the full plan after the four diagnostic slots.
		await evaluateCommand(flags, options);

		return;
	}

	if (!diagnostic.report.passed) {
		throw new Error(`targeted diagnostic blocked; the full local suite did not start: ${diagnostic.report.blocking.join('; ')}`);
	}

	process.stderr.write(
		`local regression ${inputs.environment.model.reference}: ${LOCAL_REGRESSION_CASE_COUNT} case(s) x ${LOCAL_REGRESSION_TREATMENT_IDS.length} treatment(s) x ${LOCAL_REGRESSION_REPETITIONS} repetition = ${LOCAL_REGRESSION_EXECUTIONS} executions\n`,
	);

	const run = await evaluateCommand(flags, options);

	if (run === null) {
		return;
	}

	const metadata = manifestMetadataOf(run.runDir);

	assertLocalClaimClass(metadata.claimClass);

	if (run.comparison === null) {
		throw new Error('local regression did not produce a paired report');
	}

	const report = localRegressionReportOf({
		diagnostic: diagnostic.report,
		report: run.comparison,
		targetMetric: inputs.targetMetric,
		diagnosticRunId: path.basename(diagnostic.run.runDir),
		diagnosticDigest: hashOf(diagnostic.report),
	});

	writeJsonAtomic(path.join(run.runDir, 'local-regression.json'), report, true);

	process.stdout.write(
		`local regression ${report.passed ? 'PASSED' : 'NOT PASSED'} claim=${report.claimClass} release-authority=${String(report.releaseAuthority)} target=${report.targetMetric} executions=${report.plan.executions}/${report.plan.expectedExecutions}\n`,
	);

	for (const trend of report.trends) {
		process.stdout.write(
			`trend ${(trend.caseClass ?? 'overall').padEnd(14)} cases ${trend.caseIds.length} success ${(trend.success.candidate * 100).toFixed(1)}% target ${trend.target.ratio === null ? 'n/a' : trend.target.ratio.toFixed(3)} regressions ${trend.regressions.length}\n`,
		);
	}

	for (const finding of report.regressions) {
		process.stdout.write(`REGRESSION ${finding.detail}\n`);
	}

	process.stdout.write(`local ${localRegressionSummaryOf(report)}\n`);
	process.stdout.write(`record ${path.join(run.runDir, 'local-regression.json')}\n`);

	if (!report.passed) {
		throw new Error(`local regression not passed: ${report.blocking.length === 0 ? 'targeted diagnosis required' : report.blocking.join('; ')}`);
	}
};
