import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {artifactRefOf} from './artifact.ts';
import {evaluateCommand, type EvaluationRunType} from './cliEvaluate.ts';
import {
	artifactsOf,
	evaluationRoot,
	evaluationStateRoot,
	flagOf,
	manifestMetadataOf,
	manifestPathOf,
	primaryCheckout,
	settingsOf,
	treatmentsOf,
} from './cliSupport.ts';
import {loadHostedReference, type HostedReferenceType} from './hostedReference.ts';
import {type TrackedMetricType} from './localContract.ts';
import {planOf, loadSuite, suiteWithModelOf, treatmentIdsOf} from './suite.ts';
import {caseHashOf} from './schema.ts';
import {
	assertReleaseClaimClass,
	RELEASE_CLAIM_CLASS,
	RELEASE_CASE_COUNT,
	RELEASE_EXECUTIONS,
	RELEASE_REPETITIONS,
	RELEASE_TREATMENT_IDS,
	modelFreePreconditionOf,
	releaseCampaignReportOf,
	releaseCampaignSummaryOf,
	type ReleaseExpectationType,
	type ReleasePreconditionType,
} from './releaseCampaign.ts';
import {writeJsonAtomic} from './result.ts';
import {subjectIdentityOf, workspaceContextOf} from './workspace.ts';
import {ensureWorkspaces} from './workspaceRestore.ts';

/** Metrics a release campaign may predeclare as its target. */
const TRACKED_METRICS: readonly TrackedMetricType[] = ['retrievalBytes', 'toolCalls', 'tokens', 'wallTimeMs'];

/** Executable whose version is pinned by a hosted reference. */
const OPENCODE_COMMAND = 'opencode';

/** Flags that would change the fixed release plan. */
const FIXED_PLAN_FLAGS = ['case', 'tag', 'treatment', 'repetitions'] as const;

/** Resolved frozen inputs for the release campaign. */
type ReleaseInputsType = Readonly<{
	suite: ReturnType<typeof loadSuite>['suite'];
	cases: ReturnType<typeof loadSuite>['cases'];
	hosted: HostedReferenceType;
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

const budgetOf = (flags: Map<string, string[]>): number | undefined => {
	const raw = flagOf(flags, 'budget-ms');

	if (raw === undefined) {
		return undefined;
	}

	const budgetMs = Number(raw);

	if (!Number.isInteger(budgetMs) || budgetMs <= 0) {
		throw new Error('--budget-ms must be a positive integer');
	}

	return budgetMs;
};

const releaseInputsOf = (flags: Map<string, string[]>): ReleaseInputsType => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined || suitePath === 'true') {
		throw new Error('--suite is required');
	}

	for (const forbidden of FIXED_PLAN_FLAGS) {
		if (flags.has(forbidden)) {
			throw new Error(`release campaign does not accept --${forbidden}; the frozen release plan is fixed`);
		}
	}

	const hosted = loadHostedReference(manifestPathOf(flags, 'hosted-reference'));
	const loaded = loadSuite(path.resolve(evaluationRoot, suitePath));
	const {cases} = loaded;
	// The frozen suite records the historical Q2 default. The release campaign
	// binds the selected hosted reference and records the resulting suite hash.
	const suite = suiteWithModelOf(loaded.suite, cases, hosted.reference);

	if (suite.status !== 'frozen') {
		throw new Error(`suite ${suite.id} must be frozen for a release campaign`);
	}

	if (cases.length !== RELEASE_CASE_COUNT) {
		throw new Error(`release campaign requires the frozen ${RELEASE_CASE_COUNT}-case suite; suite ${suite.id} declares ${cases.length} case(s)`);
	}

	if (suite.repetitions !== RELEASE_REPETITIONS) {
		throw new Error(`release campaign requires ${RELEASE_REPETITIONS} paired repetitions; suite ${suite.id} declares ${suite.repetitions}`);
	}

	const treatmentIds = treatmentIdsOf(suite.treatments);

	if (treatmentIds.join(',') !== RELEASE_TREATMENT_IDS.join(',')) {
		throw new Error(`release campaign requires treatments ${RELEASE_TREATMENT_IDS.join(', ')}; suite ${suite.id} declares ${treatmentIds.join(', ')}`);
	}

	return {suite, cases, hosted, targetMetric: targetMetricOf(flags)};
};

const readJson = (file: string, label: string): unknown => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

		return parsed;
	} catch (error) {
		throw new Error(`could not read ${label} at ${file}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
	}
};

const assertHostedRuntime = (hosted: HostedReferenceType): void => {
	const version = execFileSync(OPENCODE_COMMAND, ['--version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
	const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u.exec(version);

	if (match === null || match[0] !== hosted.runtime.opencode) {
		throw new Error(`hosted reference ${hosted.id} pins OpenCode ${hosted.runtime.opencode}, but the measured runtime is ${match?.[0] ?? 'unknown'}`);
	}
};

const stagedArtifactsOf = (inputs: ReleaseInputsType, settings: Readonly<{subjectRepo: string}>): ReleaseExpectationType['artifacts'] => {
	const treatments = treatmentsOf('all', inputs.suite.treatments);
	const subject = subjectIdentityOf(settings.subjectRepo, inputs.suite.revision);
	const context = workspaceContextOf(evaluationStateRoot, {subjectRepo: settings.subjectRepo, subject, evaluationRoot, primaryCheckout});

	ensureWorkspaces(context, treatments);

	const artifacts = artifactsOf(context, treatments);

	return {
		accepted: artifactRefOf(artifacts.get('accepted') ?? null),
		candidate: artifactRefOf(artifacts.get('candidate') ?? null),
	};
};

const optionsOf = (
	inputs: ReleaseInputsType,
	flags: Map<string, string[]>,
	settings: Readonly<{subjectRepo: string}>,
): Parameters<typeof evaluateCommand>[1] => {
	const budgetMs = budgetOf(flags);

	return {
		treatments: [...RELEASE_TREATMENT_IDS],
		repetitions: RELEASE_REPETITIONS,
		hostedReference: inputs.hosted,
		requireFrozen: true,
		model: inputs.hosted.reference,
		claimClass: RELEASE_CLAIM_CLASS,
		comparison: true,
		settings,
		...(budgetMs === undefined ? {} : {budgetMs}),
	};
};

type PreconditionsType = Readonly<{modelFree: ReleasePreconditionType}>;

const preconditionsOf = (modelFreePath: string, expectation: ReleaseExpectationType): PreconditionsType => ({
	modelFree: modelFreePreconditionOf(readJson(modelFreePath, 'model-free report'), expectation),
});

const printReportOf = (report: ReturnType<typeof releaseCampaignReportOf>, runDir: string): void => {
	process.stdout.write(
		`release ${report.passed ? 'PASSED' : 'NOT PASSED'} claim=${report.claimClass} release-authority=${String(report.releaseAuthority)} model=${report.hosted.reference} executions=${report.plan.executions}/${report.plan.expectedExecutions} valid=${report.plan.validExecutions} invalid=${report.plan.invalidExecutions}\n`,
	);

	for (const verdict of report.classes) {
		process.stdout.write(
			`class ${verdict.class.padEnd(14)} success ${(verdict.success.candidate * 100).toFixed(1)}% target ${verdict.target.medianRatio === null ? 'n/a' : verdict.target.medianRatio.toFixed(3)} regressions ${verdict.regressions.length}\n`,
		);
	}

	for (const threshold of report.overall.thresholds) {
		process.stdout.write(`${threshold.passed ? 'PASS' : 'FAIL'} ${threshold.name} (${threshold.detail})\n`);
	}

	for (const finding of report.blocking) {
		process.stdout.write(`BLOCKING ${finding}\n`);
	}

	process.stdout.write(`${releaseCampaignSummaryOf(report)}\n`);
	process.stdout.write(`record ${path.join(runDir, 'release-campaign.json')}\n`);
};

/**
 * Runs the deferred hosted release campaign.
 *
 * The command refuses to start a model unless a passing model-free route report
 * covers the same suite, revision, and staged artifacts. Independent local
 * qualification is neither read nor promoted to a precondition. It then runs
 * exactly 18 cases × 3 treatments × 5 paired repetitions and writes a sanitized
 * hosted-model-scoped record. A changed hosted reference changes the campaign
 * identity and therefore requires a new paired baseline.
 *
 * @param flags - Parsed CLI flags.
 * @param options - Injected harness settings; the CLI reads machine-local settings only when absent.
 */
export const releaseCommand = async (flags: Map<string, string[]>, options: Readonly<{settings?: Readonly<{subjectRepo: string}>}> = {}): Promise<void> => {
	const settings = options.settings ?? settingsOf();
	const inputs = releaseInputsOf(flags);
	const evaluationOptions = optionsOf(inputs, flags, settings);

	if (flags.has('dry-run')) {
		await evaluateCommand(flags, evaluationOptions);

		return;
	}

	assertHostedRuntime(inputs.hosted);

	const modelFreePath = manifestPathOf(flags, 'model-free');
	const artifacts = stagedArtifactsOf(inputs, settings);
	const expectation: ReleaseExpectationType = {
		suite: {id: inputs.suite.id, version: inputs.suite.version, hash: inputs.suite.hash, revision: inputs.suite.revision},
		cases: inputs.cases.map((testCase) => ({id: testCase.id, hash: caseHashOf(testCase)})),
		targetMetric: inputs.targetMetric,
		artifacts,
	};
	const preconditions = preconditionsOf(modelFreePath, expectation);

	process.stderr.write(
		`release ${inputs.hosted.reference}: ${RELEASE_CASE_COUNT} case(s) x ${RELEASE_TREATMENT_IDS.length} treatment(s) x ${RELEASE_REPETITIONS} repetitions = ${RELEASE_EXECUTIONS} executions\n`,
	);

	const run: EvaluationRunType | null = await evaluateCommand(flags, evaluationOptions);

	if (run === null) {
		return;
	}

	const metadata = manifestMetadataOf(run.runDir);

	assertReleaseClaimClass(metadata.claimClass);

	if (run.comparison === null) {
		throw new Error('release campaign did not produce a paired report');
	}

	const report = releaseCampaignReportOf({
		hosted: inputs.hosted,
		expectation,
		preconditions,
		expectedSlots: planOf(inputs.cases, [...RELEASE_TREATMENT_IDS], RELEASE_REPETITIONS),
		results: run.results,
		report: run.comparison,
	});

	writeJsonAtomic(path.join(run.runDir, 'release-campaign.json'), report, true);
	printReportOf(report, run.runDir);

	if (!report.passed) {
		throw new Error(`release campaign not passed: ${report.blocking.length === 0 ? 'no blocking finding' : report.blocking.join('; ')}`);
	}
};
