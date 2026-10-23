import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {artifactRefOf, type ArtifactRefType} from './artifact.ts';
import {campaignManifestOf, type CampaignManifestType} from './campaignManifest.ts';
import {assertClaimEnvironmentOf, type CampaignClaimClassType} from './campaignClaim.ts';
import {assertEnvironmentModel, type EnvironmentManifestType} from './environment.ts';
import {assertHostedModel, type HostedReferenceType} from './hostedReference.ts';
import {comparisonDigestOf, executionIdentityDigestOf, executionIdentityOf, identityDigestOf, identityOf} from './identity.ts';
import {clientStoreOf, prepareClientStore, type ClientStoreType} from './isolation.ts';
import {budgetOf, printEvaluationPlanOf} from './cliPlan.ts';
import {compare} from './report.ts';
import {resumeDecisionOf, resumeStateOf, storeAttemptsOf, writeJsonAtomic} from './result.ts';
import {printSummary} from './cliSummary.ts';
import {runOnce, withRestoration} from './runner.ts';
import {type RunResultType} from './runTypes.ts';
import {loadSuite, planHashOf, planOf, resolveTreatmentOf, selectCases, suiteWithModelOf, treatmentIdsOf} from './suite.ts';
import {prepareTreatmentProofOf} from './surfaceProof.ts';
import {type ToolSurfaceType, type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';
import {applyTreatment, subjectIdentityOf, treatmentConfigOf, workspaceContextOf} from './workspace.ts';
import {assertCheckout, ensureWorkspaces, restoreWorkspace} from './workspaceRestore.ts';
import {
	HARNESS_VERSION,
	allOf,
	artifactsOf,
	ensureManifestAt,
	evaluationRoot,
	flagOf,
	runArtifactsOf,
	settingsOf,
	surfacesOf,
	treatmentsOf,
	PACE_MS,
} from './cliSupport.ts';

/**
 * Consecutive model-free cold starts every treatment must survive before the
 * first hosted-model request. Validity v2 fixes this at twenty.
 */
const COLD_START_RUNS = 20;

export type EvaluationOptionsType = Readonly<{
	/** Restrict the run to these treatments; flags cannot widen it. */
	treatments?: readonly string[];
	repetitions?: number;
	/** Cold-start proofs per treatment; production uses the fixed twenty. */
	coldStarts?: number;
	/** Restrict the run to this ordered case subset. */
	caseIds?: readonly string[];
	environment?: EnvironmentManifestType | null;
	/** Pinned hosted reference for a hosted-model campaign. */
	hostedReference?: HostedReferenceType | null;
	requireFrozen?: boolean;
	/** Model override for a calibrated local candidate; case hashes stay pinned. */
	model?: string;
	/** Total wall-clock budget for all planned executions. */
	budgetMs?: number;
	/** Write the ordinary paired report; false for diagnostics and calibration. */
	comparison?: boolean;
	/** Evidence class this campaign may support. Never inferred from results. */
	claimClass?: CampaignClaimClassType;
}>;

export type EvaluationRunType = Readonly<{
	runDir: string;
	results: readonly RunResultType[];
	/** Null only when a budget stopped the campaign before its first execution. */
	comparison: ReturnType<typeof compare> | null;
	budget: Readonly<{budgetMs: number; elapsedMs: number; exceeded: boolean}> | null;
}>;

/** Resolved evaluation plan and the identity pinned for its campaign. */
export type EvaluationSetupType = Readonly<{
	flags: Map<string, string[]>;
	suite: ReturnType<typeof loadSuite>['suite'];
	selected: ReturnType<typeof selectCases>;
	treatments: ReturnType<typeof treatmentsOf>;
	repetitions: number;
	coldStarts: number;
	environment: EnvironmentManifestType | null;
	hostedReference: HostedReferenceType | null;
	plan: ReturnType<typeof planOf>;
	planHash: string;
	identity: ReturnType<typeof identityOf>;
	identityDigest: string;
	comparisonDigest: string;
	runDir: string;
	clientStore: ClientStoreType;
	subject: ReturnType<typeof subjectIdentityOf>;
	context: ReturnType<typeof workspaceContextOf>;
}>;

/** Captured tool surfaces and the per-treatment configuration digests. */
type SurfacesType = Readonly<{
	surfaces: Awaited<ReturnType<typeof surfacesOf>>;
	treatmentContexts: ReadonlyMap<TreatmentIdType, Readonly<{surface: ToolSurfaceType; configDigest: string}>>;
}>;

const coldStartsOfOptions = (options: EvaluationOptionsType): number => {
	// A hosted claim always runs the fixed twenty. Local diagnostics and the
	// deterministic CLI tests may lower the count explicitly; they never widen it.
	const declared = options.claimClass === 'hosted-model-scoped' ? COLD_START_RUNS : Number(process.env['EVAL_COLD_STARTS'] ?? COLD_START_RUNS);
	const coldStarts = options.coldStarts ?? declared;

	if (!Number.isInteger(coldStarts) || coldStarts < 1) {
		throw new Error('cold-start proof count must be a positive integer');
	}

	return coldStarts;
};

const setupEvaluationOf = (flags: Map<string, string[]>, options: EvaluationOptionsType): EvaluationSetupType => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const loaded = loadSuite(path.resolve(evaluationRoot, suitePath));
	const suite = options.model === undefined ? loaded.suite : suiteWithModelOf(loaded.suite, loaded.cases, options.model);
	const {cases} = loaded;

	if (options.requireFrozen === true && suite.status !== 'frozen') {
		throw new Error(`suite ${suite.id} must be frozen`);
	}

	const selected = selectCases(cases, {caseIds: options.caseIds ?? allOf(flags, 'case'), tags: allOf(flags, 'tag')});
	const treatments =
		options.treatments === undefined
			? treatmentsOf(flagOf(flags, 'treatment'), suite.treatments)
			: treatmentsOf(options.treatments.join(','), suite.treatments);
	const repetitions = options.repetitions ?? Number(flagOf(flags, 'repetitions') ?? suite.repetitions);
	const coldStarts = coldStartsOfOptions(options);
	const environment = options.environment ?? null;
	const hostedReference = options.hostedReference ?? null;

	if (environment !== null) {
		assertEnvironmentModel(environment, suite.model);
	}

	if (hostedReference !== null) {
		assertHostedModel(hostedReference, suite.model);
	}

	assertClaimEnvironmentOf(options.claimClass, environment, hostedReference);

	const plan = planOf(selected, treatmentIdsOf(treatments), repetitions);
	const planHash = planHashOf(plan);
	const identity = identityOf({
		suite,
		cases: selected,
		treatments: suite.treatments,
		repetitions,
		planHash,
		harnessVersion: HARNESS_VERSION,
		environment,
		hostedReference,
	});
	const identityDigest = identityDigestOf(identity);
	const comparisonDigest = comparisonDigestOf(identity);
	const runDir = path.join(evaluationRoot, 'results', `${suite.id}-${identityDigest.slice(0, 16)}`);
	const campaignStoreFlag = flagOf(flags, 'campaign-store');
	const clientStore: ClientStoreType = clientStoreOf({
		campaignStore: campaignStoreFlag === undefined ? null : campaignStoreFlag === 'true' ? '' : campaignStoreFlag,
		campaignDir: runDir,
	});
	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(evaluationRoot, {subjectRepo: settings.subjectRepo, subject});

	return {
		flags,
		suite,
		selected,
		treatments,
		repetitions,
		coldStarts,
		environment,
		hostedReference,
		plan,
		planHash,
		identity,
		identityDigest,
		comparisonDigest,
		runDir,
		clientStore,
		subject,
		context,
	};
};

const surfaceForOf = (surfaces: Awaited<ReturnType<typeof surfacesOf>>, treatment: TreatmentDefinitionType): ToolSurfaceType => {
	const surface = surfaces.get(treatment.id);

	if (surface === undefined) {
		throw new Error(`treatment ${treatment.id} has no captured tool surface`);
	}

	return surface;
};

const prepareSurfacesOf = async (setup: EvaluationSetupType): Promise<SurfacesType> => {
	const surfaces = await surfacesOf(setup.context, setup.treatments);

	// The final configuration names the ordinary tools and the captured native
	// MCP tools exactly. Each treatment must first prove actual MCP readiness and
	// then present the exact surface on the first agent request of every cold
	// start. Any missing, late, duplicated, or unknown tool aborts the campaign
	// before the first hosted-model request.
	for (const treatment of setup.treatments) {
		const surface = surfaceForOf(surfaces, treatment);

		applyTreatment(setup.context, treatment, surface);
		const {readiness, captured} = await prepareTreatmentProofOf({
			runDir: setup.runDir,
			coldStarts: setup.coldStarts,
			context: setup.context,
			treatment,
			surface,
		});

		process.stderr.write(
			`surface ${treatment.id} agent request 1 exact across ${setup.coldStarts} cold start(s)${readiness === null ? '' : ` after ${readiness.attempts} readiness attempt(s)`}: ${captured.tools.join(', ')}\n`,
		);
	}

	const treatmentContexts = new Map<TreatmentIdType, Readonly<{surface: ToolSurfaceType; configDigest: string}>>();

	for (const treatment of setup.treatments) {
		const surface = surfaceForOf(surfaces, treatment);
		const {digest: configDigest} = treatmentConfigOf(setup.context, treatment, surface);

		treatmentContexts.set(treatment.id, {surface, configDigest});
	}

	return {surfaces, treatmentContexts};
};

/** One slot of the pinned campaign plan. */
type SlotInputType = Readonly<{
	setup: EvaluationSetupType;
	artifacts: ReturnType<typeof artifactsOf>;
	treatmentContexts: SurfacesType['treatmentContexts'];
	campaignId: string;
	budgetDeadline: number | null;
	entry: ReturnType<typeof planOf>[number];
	testCase: ReturnType<typeof selectCases>[number];
	index: number;
}>;

const slotResultOf = async (input: SlotInputType): Promise<Readonly<{result: RunResultType; executed: boolean}>> => {
	const {setup, entry} = input;
	const treatment = resolveTreatmentOf(entry, setup.treatments);
	const treatmentContext = input.treatmentContexts.get(treatment.id);

	if (treatmentContext === undefined) {
		throw new Error(`no captured surface for treatment ${treatment.id}`);
	}

	const acceptedRef: ArtifactRefType | null = artifactRefOf(input.artifacts.get('accepted') ?? null);
	const candidateRef: ArtifactRefType | null = artifactRefOf(input.artifacts.get('candidate') ?? null);
	const executionIdentity = executionIdentityOf({
		suite: setup.suite,
		testCase: input.testCase,
		model: setup.suite.model,
		treatment,
		surface: treatmentContext.surface,
		subject: {
			mode: setup.subject.mode,
			revision: setup.subject.revision,
			contentManifestHash: setup.subject.contentManifestHash,
			lockFileHash: setup.subject.lockFileHash,
		},
		artifacts: {accepted: acceptedRef, candidate: candidateRef},
		configDigest: treatmentContext.configDigest,
		repetitionIndex: entry.repetition,
		randomizationSeed: setup.identityDigest,
		harnessVersion: HARNESS_VERSION,
		environment: setup.environment,
		hostedReference: setup.hostedReference,
	});
	const slotIdentityDigest = executionIdentityDigestOf(executionIdentity);
	const slotDirectory = path.join(setup.runDir, entry.caseId, entry.treatment, `rep-${entry.repetition}`);
	const resume = resumeDecisionOf(resumeStateOf(slotDirectory, slotIdentityDigest), setup.flags);

	if (resume.record !== null) {
		process.stderr.write(
			`[${input.index + 1}/${setup.plan.length}] ${entry.caseId} ${entry.treatment} rep-${entry.repetition} resumed attempt ${resume.attempt}\n`,
		);

		return {result: resume.record, executed: false};
	}

	// RestoreWorkspace writes the ordinary-only configuration, so the exact
	// captured surface is rewritten before every slot and before every retry.
	applyTreatment(setup.context, treatment, treatmentContext.surface);

	// Reject, never silently repair: a dirty workspace would observe unpinned content.
	const verification = assertCheckout(setup.context, treatment);

	process.stderr.write(
		`[${input.index + 1}/${setup.plan.length}] ${entry.caseId} ${entry.treatment} rep-${entry.repetition}${resume.retryingTimedOut ? ` retrying timed-out attempt ${resume.attempt}` : ''}\n`,
	);

	const attemptResults: RunResultType[] = [];
	const execution = await runOnce({
		cwd: setup.context.workspacePath(treatment.id),
		testCase: input.testCase,
		treatment,
		surface: treatmentContext.surface,
		repetition: entry.repetition,
		model: setup.suite.model,
		revision: setup.suite.revision,
		campaignId: input.campaignId,
		identity: executionIdentity,
		identityDigest: slotIdentityDigest,
		clientStore: setup.clientStore,
		isolation: {
			mode: setup.subject.mode,
			clientStore: setup.clientStore.mode,
			checkoutClean: verification.checkoutClean,
			revisionMatch: verification.revisionMatch,
		},
		artifacts: runArtifactsOf(input.artifacts, treatment),
		mcpServers: treatment.mcp === null ? [] : [treatment.mcp.server],
		rawBase: path.join(slotDirectory, 'raw'),
		firstAttempt: resume.nextAttempt,
		prepareRetry: () => restoreWorkspace(setup.context, treatment, treatmentContext.surface),
		...(input.budgetDeadline === null ? {} : {timeoutMs: Math.max(1, input.budgetDeadline - Date.now())}),
		onAttempt: (attemptResult) => {
			attemptResults.push(attemptResult);
		},
	});
	const result = withRestoration(execution, restoreWorkspace(setup.context, treatment, treatmentContext.surface));

	if (result.attempts.length > 1) {
		process.stderr.write(`  retried ${result.attempts.length - 1} time(s); last reason ${result.invalidReason ?? 'accepted'}\n`);
	}

	storeAttemptsOf(slotDirectory, attemptResults, result);

	if (!result.isolation.restored || result.defects.includes('dirty-isolation')) {
		throw new Error(
			`restoration failed for ${treatment.id} after ${entry.caseId} rep-${entry.repetition}: ${result.invalidReason ?? 'unknown'}; the campaign stopped so no later execution observes edited content`,
		);
	}

	return {result, executed: true};
};

const executePlanOf = async (
	input: Readonly<{
		setup: EvaluationSetupType;
		artifacts: ReturnType<typeof artifactsOf>;
		treatmentContexts: SurfacesType['treatmentContexts'];
		campaignId: string;
		budgetDeadline: number | null;
	}>,
): Promise<Readonly<{results: readonly RunResultType[]; budgetExceeded: boolean}>> => {
	const results: RunResultType[] = [];
	let budgetExceeded = false;

	for (const [index, entry] of input.setup.plan.entries()) {
		const testCase = input.setup.selected.find((item) => item.id === entry.caseId);

		if (testCase === undefined) {
			throw new Error(`unknown case ${entry.caseId}`);
		}

		if (input.budgetDeadline !== null && Date.now() >= input.budgetDeadline) {
			budgetExceeded = true;
			process.stderr.write(`budget exceeded before ${entry.caseId} ${entry.treatment} rep-${entry.repetition}; abandoning the remaining slots\n`);
			break;
		}

		const slot = await slotResultOf({...input, entry, testCase, index});

		results.push(slot.result);

		// Pacing protects live calls; a slot restored from disk starts none.
		if (slot.executed && index < input.setup.plan.length - 1) {
			await delay(PACE_MS);
		}
	}

	return {results, budgetExceeded};
};

// Calibration writes its own qualification decision. The ordinary paired
// report requires treatment-identical agent surfaces, which calibration
// intentionally does not have because accepted adds native MCP tools.
const comparisonOf = (results: readonly RunResultType[], manifest: CampaignManifestType, options: EvaluationOptionsType): ReturnType<typeof compare> | null =>
	options.comparison === false || results.length === 0 ? null : compare(results, manifest);

const writeCampaignOutcomeOf = (
	setup: EvaluationSetupType,
	manifest: CampaignManifestType,
	comparison: ReturnType<typeof compare> | null,
	budget: Readonly<{budgetMs: number; elapsedMs: number; exceeded: boolean}> | null,
): void => {
	if (comparison !== null) {
		writeJsonAtomic(path.join(setup.runDir, 'report.json'), comparison, true);
	}

	writeJsonAtomic(
		path.join(setup.runDir, 'run.json'),
		{...manifest, status: budget?.exceeded === true ? 'incomplete' : 'complete', budget, finishedAt: new Date().toISOString()},
		true,
	);
};

const savedExecutionOf = async (
	input: Readonly<{
		setup: EvaluationSetupType;
		artifacts: ReturnType<typeof artifactsOf>;
		treatmentContexts: SurfacesType['treatmentContexts'];
		campaignId: string;
		budgetDeadline: number | null;
		manifest: CampaignManifestType;
	}>,
): Promise<Readonly<{results: readonly RunResultType[]; budgetExceeded: boolean}>> => {
	try {
		return await executePlanOf(input);
	} catch (error) {
		writeJsonAtomic(
			path.join(input.setup.runDir, 'run.json'),
			{
				...input.manifest,
				status: 'failed',
				failure: error instanceof Error ? error.message : String(error),
				finishedAt: new Date().toISOString(),
			},
			true,
		);

		throw error;
	}
};

export const evaluateCommand = async (flags: Map<string, string[]>, options: EvaluationOptionsType = {}): Promise<EvaluationRunType | null> => {
	const setup = setupEvaluationOf(flags, options);
	const {runDir, suite, treatments, plan, identityDigest, clientStore, context} = setup;

	printEvaluationPlanOf(setup);

	if (flags.has('dry-run')) {
		for (const entry of plan) {
			process.stderr.write(`  ${entry.caseId} ${entry.treatment} rep-${entry.repetition}\n`);
		}

		return null;
	}

	ensureWorkspaces(context, treatments);
	const artifacts = artifactsOf(context, treatments);
	mkdirSync(runDir, {recursive: true});
	prepareClientStore(clientStore);

	for (const [id, artifactIdentity] of artifacts) {
		if (artifactIdentity !== null) {
			process.stderr.write(`artifact ${id} ${artifactIdentity.id} ${artifactIdentity.digest} (${artifactIdentity.fileCount} files)\n`);
		}
	}

	const {surfaces, treatmentContexts} = await prepareSurfacesOf(setup);
	const campaignId = `${suite.id}-${identityDigest.slice(0, 16)}`;
	const manifest = campaignManifestOf(setup, {artifacts, surfaces, treatmentContexts}, options.claimClass ?? 'none');

	ensureManifestAt(path.join(runDir, 'manifest.json'), manifest);
	writeJsonAtomic(path.join(runDir, 'run.json'), {...manifest, status: 'running'}, true);

	const budgetStartedAt = Date.now();
	const budgetDeadline = options.budgetMs === undefined ? null : budgetStartedAt + options.budgetMs;
	const {results, budgetExceeded} = await savedExecutionOf({setup, artifacts, treatmentContexts, campaignId, budgetDeadline, manifest});
	const budget = budgetOf(options.budgetMs, budgetStartedAt, budgetExceeded);

	if (budget?.exceeded === true) {
		process.stderr.write(`budget exceeded after ${budget.elapsedMs} ms of ${options.budgetMs} ms\n`);
	}

	const comparison = comparisonOf(results, manifest, options);

	writeCampaignOutcomeOf(setup, manifest, comparison, budget);

	if (comparison !== null) {
		printSummary(runDir, results, comparison);
	}

	return {runDir, results, comparison, budget};
};
