import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {artifactRefOf, type ArtifactRefType} from './artifact.ts';
import {campaignManifestOf, type CampaignManifestType} from './campaignManifest.ts';
import {assertEnvironmentModel, type EnvironmentManifestType} from './environment.ts';
import {comparisonDigestOf, executionIdentityDigestOf, executionIdentityOf, identityDigestOf, identityOf} from './identity.ts';
import {clientStoreOf, prepareClientStore, type ClientStoreType} from './isolation.ts';
import {compare} from './report.ts';
import {resultPathOf, resumeStateOf, writeJsonAtomic, writeResult} from './result.ts';
import {printSummary} from './cliSummary.ts';
import {runOnce, withRestoration} from './runner.ts';
import {type RunResultType} from './runTypes.ts';
import {loadSuite, planHashOf, planOf, resolveTreatmentOf, selectCases, suiteWithModelOf, treatmentIdsOf} from './suite.ts';
import {type ToolSurfaceType, type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';
import {assertPresentedSurface} from './surface.ts';
import {capturePresentedTools} from './surfaceProbe.ts';
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

export type EvaluationOptionsType = Readonly<{
	/** Restrict the run to these treatments; flags cannot widen it. */
	treatments?: readonly string[];
	repetitions?: number;
	/** Restrict the run to this ordered case subset. */
	caseIds?: readonly string[];
	environment?: EnvironmentManifestType | null;
	requireFrozen?: boolean;
	/** Model override for a calibrated local candidate; case hashes stay pinned. */
	model?: string;
	/** Total wall-clock budget for all planned executions. */
	budgetMs?: number;
	/** Write the ordinary paired report; false for diagnostics and calibration. */
	comparison?: boolean;
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
	environment: EnvironmentManifestType | null;
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
	const environment = options.environment ?? null;

	if (environment !== null) {
		assertEnvironmentModel(environment, suite.model);
	}

	const plan = planOf(selected, treatmentIdsOf(treatments), repetitions);
	const planHash = planHashOf(plan);
	const identity = identityOf({suite, cases: selected, treatments: suite.treatments, repetitions, planHash, harnessVersion: HARNESS_VERSION, environment});
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
		environment,
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

const printEvaluationPlanOf = (setup: EvaluationSetupType): void => {
	const {selected, treatments, repetitions, plan, planHash, identityDigest, runDir, environment, subject, clientStore} = setup;
	const pinned =
		subject.revision === null
			? `revision=${subject.declaredRevision} (copy) content=${subject.contentManifestHash.slice(0, 16)}`
			: `revision=${subject.revision.slice(0, 7)}`;

	process.stderr.write(
		`run ${runDir}\nplan ${plan.length} execution(s): ${selected.length} case(s) x ${treatments.length} treatment(s) x ${repetitions} repetition(s)\n`,
	);
	process.stderr.write(`plan-hash ${planHash}\nidentity ${identityDigest}\n`);

	if (environment !== null) {
		process.stderr.write(
			`environment ${environment.id} ${environment.model.reference} digest ${environment.model.digest} runtime ollama ${environment.runtime.ollama} / opencode ${environment.runtime.opencode}\n`,
		);
	}

	process.stderr.write(
		`isolation ${subject.mode}, ${pinned}, standalone server, client store ${clientStore.mode}${clientStore.path === null ? '' : ` at ${clientStore.path}`}\n`,
	);
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
	// MCP tools exactly. A model-free probe records the tool list OpenCode sends
	// to a provider and must match that declaration before any model process
	// starts; an extra or missing tool aborts the campaign.
	for (const treatment of setup.treatments) {
		const surface = surfaceForOf(surfaces, treatment);

		applyTreatment(setup.context, treatment, surface);
		const captured = await capturePresentedTools({workspace: setup.context.workspacePath(treatment.id), surface});
		const observed = assertPresentedSurface(surface, captured.tools);

		process.stderr.write(`surface ${treatment.id} ${observed.length} tool(s): ${observed.join(', ')}\n`);
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

const slotResultOf = async (input: SlotInputType): Promise<RunResultType> => {
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
	});
	const slotIdentityDigest = executionIdentityDigestOf(executionIdentity);
	const slotDirectory = path.join(setup.runDir, entry.caseId, entry.treatment, `rep-${entry.repetition}`);
	const resume = resumeStateOf(slotDirectory, slotIdentityDigest);

	if (setup.flags.has('resume') && resume.record !== null) {
		process.stderr.write(
			`[${input.index + 1}/${setup.plan.length}] ${entry.caseId} ${entry.treatment} rep-${entry.repetition} resumed attempt ${resume.attempt}\n`,
		);

		return resume.record;
	}

	// RestoreWorkspace writes the ordinary-only configuration, so the exact
	// captured surface is rewritten before every slot and before every retry.
	applyTreatment(setup.context, treatment, treatmentContext.surface);

	// Reject, never silently repair: a dirty or mismatched workspace would
	// mean the execution observes content the suite did not pin.
	const verification = assertCheckout(setup.context, treatment);

	process.stderr.write(`[${input.index + 1}/${setup.plan.length}] ${entry.caseId} ${entry.treatment} rep-${entry.repetition}\n`);

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

	for (const [attemptIndex, attemptResult] of attemptResults.entries()) {
		const stored = attemptIndex === attemptResults.length - 1 ? result : attemptResult;

		writeResult(resultPathOf(slotDirectory, stored.attempt), stored);
	}

	if (!result.isolation.restored || result.defects.includes('dirty-isolation')) {
		throw new Error(
			`restoration failed for ${treatment.id} after ${entry.caseId} rep-${entry.repetition}: ${result.invalidReason ?? 'unknown'}; the campaign stopped so no later execution observes edited content`,
		);
	}

	return result;
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

		results.push(await slotResultOf({...input, entry, testCase, index}));

		if (index < input.setup.plan.length - 1) {
			await delay(PACE_MS);
		}
	}

	return {results, budgetExceeded};
};

const budgetOf = (
	budgetMs: number | undefined,
	startedAt: number,
	exceeded: boolean,
): Readonly<{budgetMs: number; elapsedMs: number; exceeded: boolean}> | null => {
	if (budgetMs === undefined) {
		return null;
	}

	const elapsedMs = Date.now() - startedAt;

	return {budgetMs, elapsedMs, exceeded: exceeded || elapsedMs > budgetMs};
};

// Calibration writes its own qualification decision. The ordinary paired
// report requires treatment-identical agent surfaces, which calibration
// intentionally does not have because accepted adds native MCP tools.
const comparisonOf = (results: readonly RunResultType[], manifest: CampaignManifestType, options: EvaluationOptionsType): ReturnType<typeof compare> | null =>
	options.comparison === false || options.budgetMs !== undefined || results.length === 0 ? null : compare(results, manifest);

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
	const manifest = campaignManifestOf(setup, {artifacts, surfaces, treatmentContexts});

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
