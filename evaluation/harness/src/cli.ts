import {existsSync, mkdirSync, readFileSync, readdirSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {artifactIdentityOf, artifactRefOf, type ArtifactIdentityType, type ArtifactRefType} from './artifact.ts';
import {calibrationDecisionOf, calibrationSelectionOf, type CalibrationDecisionType} from './calibration.ts';
import {
	assertEnvironmentMatches,
	assertEnvironmentModel,
	assertEnvironmentPurpose,
	capturedEnvironmentOf,
	ENVIRONMENT_PURPOSES,
	environmentHashOf,
	environmentProbeOf,
	hostFactsOf,
	loadEnvironmentManifest,
	type EnvironmentManifestType,
} from './environment.ts';
import {hashOf} from './hash.ts';
import {
	EXECUTION_SCHEMA_VERSION,
	comparisonDigestOf,
	executionIdentityDigestOf,
	executionIdentityOf,
	identityDigestOf,
	identityOf,
	modelIdentityOf,
} from './identity.ts';
import {campaignStoreRecordOf, clientStoreOf, isolationRecordOf, prepareClientStore, type ClientStoreType} from './isolation.ts';
import {catalogOf} from './mcp.ts';
import {compare, type ReportMetadataType} from './report.ts';
import {effectiveValidityOf, readResult, resultPathOf, resumeStateOf, writeJsonAtomic, writeResult, type StoredResultType} from './result.ts';
import {openMcpSession} from './routeClient.ts';
import {runContractProbes} from './routeContract.ts';
import {loadRoutePlan, routePlanHashOf, validateRoutePlan} from './routePlan.ts';
import {routeReportOf, type RouteCaseReportType} from './routeReport.ts';
import {ROUTE_TREATMENTS, runRoute, type RouteRunType, type RouteTreatmentType} from './route.ts';
import {runOnce, withRestoration, type RunArtifactsType, type RunResultType} from './runner.ts';
import {caseHashOf} from './schema.ts';
import {loadSuite, planHashOf, planOf, resolveTreatmentOf, selectCases, suiteWithModelOf, treatmentIdsOf} from './suite.ts';
import {
	canonicalTreatmentsOf,
	toolSurfaceOf,
	treatmentDifferencesOf,
	type ToolSurfaceType,
	type TreatmentDefinitionType,
	type TreatmentIdType,
} from './treatment.ts';
import {assertCheckout, ensureWorkspaces, restoreWorkspace, subjectIdentityOf, treatmentConfigOf, workspaceContextOf} from './workspace.ts';

/** Harness schema version recorded in every run identity. */
const HARNESS_VERSION = 10;

/** Declared wall-clock budget for one local-model calibration. */
const CALIBRATION_BUDGET_MS = 15 * 60 * 1_000;

/** Frozen calibration subset size required by strategy §10. */
const CALIBRATION_CASE_COUNT = 6;

/** Treatments compared by a local calibration. */
const CALIBRATION_TREATMENTS = ['no-index', 'accepted'] as const;

/** Pause between executions to stay inside the provider's rolling window. */
const PACE_MS = Number(process.env['EVAL_PACE_MS'] ?? 5_000);

/** Directory containing the harness package. */
const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directory holding suites, cases, reports, and generated run artifacts. */
const evaluationRoot = path.resolve(process.env['EVALUATION_ROOT'] ?? path.join(harnessRoot, '..'));

const argsOf = (argv: readonly string[]): Readonly<{command: string; flags: Map<string, string[]>}> => {
	const [command = 'help', ...rest] = argv;
	const flags = new Map<string, string[]>();

	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];

		if (!token?.startsWith('--')) {
			continue;
		}

		const next = rest[index + 1];
		const value = next === undefined || next.startsWith('--') ? 'true' : next;

		if (value !== 'true') {
			index += 1;
		}

		flags.set(token.slice(2), [...(flags.get(token.slice(2)) ?? []), value]);
	}

	return {command, flags};
};

const flagOf = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.[0];
const allOf = (flags: Map<string, string[]>, name: string): readonly string[] => flags.get(name) ?? [];

const settingsOf = (): Readonly<{subjectRepo: string}> => {
	const file = path.join(harnessRoot, 'harness.json');
	const fallback = path.resolve(evaluationRoot, '..');

	if (!existsSync(file)) {
		return {subjectRepo: fallback};
	}

	const parsed = JSON.parse(readFileSync(file, 'utf8')) as {subjectRepo?: unknown};

	if (typeof parsed.subjectRepo !== 'string') {
		throw new Error('harness.json must declare "subjectRepo"');
	}

	return {subjectRepo: path.resolve(harnessRoot, parsed.subjectRepo)};
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const throwManifestShape = (field: string): never => {
	throw new Error(`manifest field "${field}" has an invalid shape`);
};

const componentsOf = (value: unknown): Readonly<Record<string, string | number>> => {
	if (!isRecord(value)) {
		throw new Error('manifest field "components" must be an object');
	}

	const components: Record<string, string | number> = {};

	for (const [key, component] of Object.entries(value)) {
		if (typeof component !== 'string' && typeof component !== 'number') {
			throw new Error('manifest field "components" may contain only string or number values');
		}

		components[key] = component;
	}

	return components;
};

/**
 * Reads the declared campaign facts a report must state.
 *
 * A report without a manifest cannot name its campaign, suite, component
 * versions, and claim class, so it is not written at all.
 *
 * @param directory - Campaign result directory.
 * @returns Manifest fields required by the report.
 */
const manifestMetadataOf = (directory: string): ReportMetadataType => {
	const file = path.join(directory, 'manifest.json');

	if (!existsSync(file)) {
		throw new Error(`no campaign manifest at ${file}; a report requires declared campaign identity`);
	}

	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
	const record = isRecord(parsed) ? parsed : throwManifestShape('root');
	const suite = isRecord(record['suite']) ? record['suite'] : throwManifestShape('suite');
	const campaignId = record['campaignId'];
	const schemaVersion = record['schemaVersion'];
	const claimClass = record['claimClass'];
	const suiteId = suite['id'];
	const suiteVersion = suite['version'];
	const suiteHash = suite['hash'];
	const suiteStatus = suite['status'];

	if (typeof campaignId !== 'string' || typeof schemaVersion !== 'string' || typeof claimClass !== 'string') {
		throw new Error('manifest field "campaignId, schemaVersion, or claimClass" has an invalid shape');
	}

	if (typeof suiteId !== 'string' || typeof suiteVersion !== 'number' || typeof suiteHash !== 'string' || typeof suiteStatus !== 'string') {
		throw new Error('manifest field "suite" has an invalid shape');
	}

	return {
		campaignId,
		schemaVersion,
		suite: {id: suiteId, version: suiteVersion, hash: suiteHash, status: suiteStatus},
		components: componentsOf(record['components']),
		claimClass,
	};
};

const treatmentsOf = (value: string | undefined, all: readonly TreatmentDefinitionType[]): readonly TreatmentDefinitionType[] => {
	const canonical = canonicalTreatmentsOf(all);

	if (value === undefined || value === 'all') {
		return canonical;
	}

	const requested = value.split(',').map((item) => item.trim());

	for (const id of requested) {
		if (!(canonical.map((treatment) => treatment.id) as readonly string[]).includes(id)) {
			throw new Error(`unsupported treatment "${id}"`);
		}
	}

	return canonical.filter((treatment) => requested.includes(treatment.id));
};

/**
 * Captures the exact tool-name list presented for every selected treatment.
 *
 * The ordinary list comes from the validated definition. The CodeIndex list
 * comes from the artifact's native MCP catalog. No model process starts before
 * every catalog has been captured.
 *
 * @param context - Workspace paths.
 * @param treatments - Selected treatment definitions.
 * @returns Surfaces keyed by treatment id and the artifact catalogs.
 */
const surfacesOf = async (
	context: ReturnType<typeof workspaceContextOf>,
	treatments: readonly TreatmentDefinitionType[],
): Promise<ReadonlyMap<TreatmentIdType, ToolSurfaceType>> => {
	const surfaces = new Map<TreatmentIdType, ToolSurfaceType>();

	for (const treatment of treatments) {
		if (treatment.kind === 'no-index') {
			surfaces.set(treatment.id, toolSurfaceOf(treatment));
			continue;
		}

		const catalog = await catalogOf(context.artifactPath(treatment), context.workspacePath(treatment.id));

		if (catalog.tools.length === 0) {
			throw new Error(`treatment ${treatment.id} artifact presented an empty MCP tool catalog`);
		}

		const surface = toolSurfaceOf(treatment, catalog.tools);

		if (!surface.native || surface.tools.includes('execute')) {
			throw new Error(`treatment ${treatment.id} did not present a native MCP tool surface`);
		}

		surfaces.set(treatment.id, surface);
	}

	return surfaces;
};

type ArtifactMapType = ReadonlyMap<TreatmentIdType, ArtifactIdentityType | null>;

/**
 * Verifies every selected artifact before any model starts.
 *
 * A CodeIndex treatment must present a complete package: a resolvable entry
 * point, every declared dependency, and a content digest that matches the
 * suite when the suite pins one. Every artifact is hashed so its identity can
 * be recorded even when no digest is declared.
 *
 * @param context - Workspace paths.
 * @param treatments - Selected treatment definitions.
 * @returns Verified identities keyed by treatment id, null for no-index.
 */
const artifactsOf = (context: ReturnType<typeof workspaceContextOf>, treatments: readonly TreatmentDefinitionType[]): ArtifactMapType => {
	const artifacts = new Map<TreatmentIdType, ArtifactIdentityType | null>();

	for (const treatment of treatments) {
		artifacts.set(treatment.id, treatment.artifact === null ? null : artifactIdentityOf(context.artifactRoot(treatment), treatment));
	}

	return artifacts;
};

/**
 * Builds the artifact references recorded with every result.
 *
 * @param artifacts - Verified identities for the selected treatments.
 * @param treatment - Treatment whose artifact the execution loads.
 * @returns Accepted, candidate, and loaded references.
 */
const runArtifactsOf = (artifacts: ArtifactMapType, treatment: TreatmentDefinitionType): RunArtifactsType => ({
	accepted: artifactRefOf(artifacts.get('accepted') ?? null),
	candidate: artifactRefOf(artifacts.get('candidate') ?? null),
	loaded: artifactRefOf(artifacts.get(treatment.id) ?? null),
});

/**
 * Writes the campaign manifest once and verifies it on resume.
 *
 * A manifest change that alters the campaign identity defines a different
 * campaign; it must never rewrite an existing manifest in place.
 *
 * @param file - Manifest path.
 * @param manifest - Campaign manifest.
 */
const ensureManifestAt = (file: string, manifest: Readonly<{campaignId: string; identityDigest: string}>): void => {
	if (!existsSync(file)) {
		writeJsonAtomic(file, manifest, false);
		return;
	}

	const existing = JSON.parse(readFileSync(file, 'utf8')) as {campaignId?: unknown; identityDigest?: unknown};

	if (existing.campaignId !== manifest.campaignId || existing.identityDigest !== manifest.identityDigest) {
		throw new Error(`campaign manifest at ${file} describes a different campaign; use a new campaign directory`);
	}
};

const listCommand = (flags: Map<string, string[]>): void => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});

	process.stdout.write(`${suite.id} v${suite.version} schema=${suite.schemaVersion} (${suite.status}) model=${suite.model} revision=${suite.revision}\n`);
	process.stdout.write(`treatments ${treatmentIdsOf(suite.treatments).join(', ')}\n`);
	process.stdout.write(`ordinary tools ${suite.treatments[0]?.ordinaryTools.join(', ') ?? 'none'}\n`);

	for (const item of selected) {
		process.stdout.write(`  ${item.id}\t${item.class}\t${item.title}\n`);
	}
};

type EvaluationOptionsType = Readonly<{
	/** Restrict the run to these treatments; flags cannot widen it. */
	treatments?: readonly string[];
	repetitions?: number;
	environment?: EnvironmentManifestType | null;
	requireFrozen?: boolean;
	/** Model override for a calibrated local candidate; case hashes stay pinned. */
	model?: string;
	/** Total wall-clock budget for all planned executions. */
	budgetMs?: number;
}>;

type EvaluationRunType = Readonly<{
	runDir: string;
	results: readonly RunResultType[];
	/** Null only when a budget stopped the campaign before its first execution. */
	comparison: ReturnType<typeof compare> | null;
	budget: Readonly<{budgetMs: number; elapsedMs: number; exceeded: boolean}> | null;
}>;

/**
 * Resolves a manifest path against the evaluation root.
 *
 * @param flags - Parsed CLI flags.
 * @param name - Flag holding the path.
 * @returns Absolute manifest path.
 */
const manifestPathOf = (flags: Map<string, string[]>, name: string): string => {
	const value = flagOf(flags, name);

	if (value === undefined || value === 'true') {
		throw new Error(`--${name} is required`);
	}

	return path.resolve(evaluationRoot, value);
};

/**
 * Measures the live environment and refuses a mismatch.
 *
 * @param environment - Committed environment manifest.
 */
const verifiedEnvironmentOf = async (environment: EnvironmentManifestType): Promise<void> => {
	const probe = await environmentProbeOf({model: environment.model.reference, endpoint: environment.runtime.ollamaEndpoint});

	assertEnvironmentMatches(environment, probe);
};

const environmentCommand = async (flags: Map<string, string[]>): Promise<void> => {
	if (flags.has('capture')) {
		const environmentPath = manifestPathOf(flags, 'output');
		const model = flagOf(flags, 'model');
		const referenceMachine = flagOf(flags, 'reference-machine');
		const id = flagOf(flags, 'id');

		if (model === undefined || model === 'true') {
			throw new Error('--model is required');
		}

		if (referenceMachine === undefined || referenceMachine === 'true') {
			throw new Error('--reference-machine is required');
		}

		if (id === undefined || id === 'true') {
			throw new Error('--id is required');
		}

		const requestedPurpose = flagOf(flags, 'purpose') ?? 'smoke';
		const purpose = ENVIRONMENT_PURPOSES.find((item) => item === requestedPurpose);

		if (purpose === undefined) {
			throw new Error(`--purpose must be one of ${ENVIRONMENT_PURPOSES.join(', ')}`);
		}

		const probe = await environmentProbeOf({model, endpoint: flagOf(flags, 'endpoint') ?? 'http://127.0.0.1:11434'});
		const environment = capturedEnvironmentOf({
			id,
			purpose,
			referenceMachine,
			recordedAt: new Date().toISOString(),
			probe,
		});

		writeJsonAtomic(environmentPath, environment, false);
		process.stdout.write(`environment ${environment.id} written to ${environmentPath}\n`);
		process.stdout.write(
			`model ${environment.model.reference} ${environment.model.digest} ${environment.model.quantization} context ${environment.model.contextLength}\n`,
		);

		return;
	}

	const environment = loadEnvironmentManifest(manifestPathOf(flags, 'environment'));
	const probe = await environmentProbeOf({model: environment.model.reference, endpoint: environment.runtime.ollamaEndpoint});

	assertEnvironmentMatches(environment, probe);

	process.stdout.write(`environment ${environment.id} matches the measured host and model\n`);
	process.stdout.write(
		`model ${environment.model.reference} ${environment.model.digest} ${environment.model.quantization} context ${environment.model.contextLength}\n`,
	);
};

const smokeCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const requestedTreatment = flagOf(flags, 'treatment');
	const requestedRepetitions = flagOf(flags, 'repetitions');

	if (requestedTreatment !== undefined && requestedTreatment !== 'accepted') {
		throw new Error('smoke runs the accepted treatment only');
	}

	if (requestedRepetitions !== undefined && requestedRepetitions !== '1') {
		throw new Error('smoke runs one repetition only');
	}

	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined || suitePath === 'true') {
		throw new Error('--suite is required');
	}

	const {suite} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const environment = loadEnvironmentManifest(manifestPathOf(flags, 'environment'));

	assertEnvironmentPurpose(environment, 'smoke');
	assertEnvironmentModel(environment, suite.model);

	if (!flags.has('dry-run')) {
		process.stderr.write(`environment ${environment.id} verification\n`);
		await verifiedEnvironmentOf(environment);
	}

	process.stderr.write(`smoke ${suite.id} ${environment.model.reference} accepted only, one repetition\n`);
	await evaluateCommand(flags, {treatments: ['accepted'], repetitions: 1, environment, requireFrozen: true});
};

const calibrationBudgetOf = (flags: Map<string, string[]>): number => {
	const raw = flagOf(flags, 'budget-ms');
	const budgetMs = raw === undefined ? CALIBRATION_BUDGET_MS : Number(raw);

	if (!Number.isInteger(budgetMs) || budgetMs <= 0) {
		throw new Error('--budget-ms must be a positive integer');
	}

	return budgetMs;
};

/**
 * Runs the frozen two-treatment calibration for one or more local models.
 *
 * The suite's case hashes stay frozen; only its model reference is rebound to
 * the environment under test. Every model receives the same 15-minute budget,
 * and a decision is written beside its retained executions.
 *
 * @param flags - Parsed CLI flags.
 */
const calibrationCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const environmentPaths = allOf(flags, 'environment');

	if (environmentPaths.length === 0) {
		throw new Error('--environment is required');
	}

	for (const forbidden of ['case', 'tag', 'treatment', 'repetitions', 'resume']) {
		if (flags.has(forbidden)) {
			throw new Error(`calibrate does not accept --${forbidden}; the frozen calibration plan is fixed`);
		}
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));

	if (suite.status !== 'frozen') {
		throw new Error(`suite ${suite.id} must be frozen for calibration`);
	}

	if (suite.repetitions !== 1 || cases.length !== CALIBRATION_CASE_COUNT) {
		throw new Error(
			`calibration requires the frozen ${CALIBRATION_CASE_COUNT}-case subset at one repetition; suite ${suite.id} declares ${cases.length} case(s) at ${suite.repetitions} repetition(s)`,
		);
	}

	const budgetMs = calibrationBudgetOf(flags);
	const environments = environmentPaths.map((value) => loadEnvironmentManifest(path.resolve(evaluationRoot, value)));

	for (const environment of environments) {
		assertEnvironmentPurpose(environment, 'calibration');
	}

	if (new Set(environments.map((environment) => environment.model.reference)).size !== environments.length) {
		throw new Error('calibrate received the same model reference more than once');
	}

	if (!flags.has('dry-run')) {
		for (const environment of environments) {
			process.stderr.write(`calibration environment ${environment.id} verification\n`);
			await verifiedEnvironmentOf(environment);
		}
	}

	process.stderr.write(
		`calibration ${suite.id} v${suite.version}, ${cases.length} case(s) x ${CALIBRATION_TREATMENTS.length} treatment(s) x 1 repetition, budget ${budgetMs} ms per model\n`,
	);

	const decisions: CalibrationDecisionType[] = [];

	for (const environment of environments) {
		const run = await evaluateCommand(flags, {
			treatments: [...CALIBRATION_TREATMENTS],
			repetitions: 1,
			environment,
			requireFrozen: true,
			model: environment.model.reference,
			budgetMs,
		});

		if (run === null) {
			continue;
		}

		const decision = calibrationDecisionOf({
			model: environment.model.reference,
			environmentId: environment.id,
			environmentHash: environmentHashOf(environment),
			budgetMs,
			elapsedMs: run.budget?.elapsedMs ?? 0,
			plannedSlots: cases.length * CALIBRATION_TREATMENTS.length,
			results: run.results,
		});

		writeJsonAtomic(path.join(run.runDir, 'calibration.json'), decision, true);
		decisions.push(decision);
		process.stdout.write(
			`${decision.passed ? 'QUALIFIED' : 'DISQUALIFIED'} ${decision.model} valid ${decision.validExecutions}/${decision.plannedSlots} accepted-exact ${decision.acceptedExact} no-index-exact ${decision.noIndexExact} elapsed ${decision.elapsedMs} ms\n`,
		);

		if (decision.disqualification !== null) {
			process.stdout.write(`disqualification ${decision.disqualification}\n`);
		}

		if (decision.telemetry.limitation !== null) {
			process.stdout.write(`telemetry ${decision.telemetry.limitation}\n`);
		}
	}

	if (flags.has('dry-run')) {
		return;
	}

	const selection = calibrationSelectionOf(decisions);
	const selectionDigest = hashOf({suite: suite.hash, budgetMs, decisions});
	const selectionDir = path.join(evaluationRoot, 'results', `${suite.id}-selection-${selectionDigest.slice(0, 16)}`);

	writeJsonAtomic(
		path.join(selectionDir, 'selection.json'),
		{
			recordType: 'calibration-selection',
			schemaVersion: 1,
			suite: {id: suite.id, version: suite.version, hash: suite.hash},
			budgetMs,
			selection,
			decisions,
		},
		true,
	);
	process.stdout.write(`selection ${selection.selected ?? 'none'} (${selection.reason})\n`);
	process.stdout.write(`record ${path.join(selectionDir, 'selection.json')}\n`);
};

const evaluateCommand = async (flags: Map<string, string[]>, options: EvaluationOptionsType = {}): Promise<EvaluationRunType | null> => {
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

	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});
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
	const identity = identityOf({
		suite,
		cases: selected,
		treatments: suite.treatments,
		repetitions,
		planHash,
		harnessVersion: HARNESS_VERSION,
		environment,
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

	for (const [id, identity] of artifacts) {
		if (identity !== null) {
			process.stderr.write(`artifact ${id} ${identity.id} ${identity.digest} (${identity.fileCount} files)\n`);
		}
	}

	const surfaces = await surfacesOf(context, treatments);

	const treatmentContexts = new Map<TreatmentIdType, Readonly<{surface: ToolSurfaceType; configDigest: string}>>();
	const manifestTreatments = treatments.map((treatment) => {
		const surface = surfaces.get(treatment.id);

		if (surface === undefined) {
			throw new Error(`treatment ${treatment.id} has no captured tool surface`);
		}

		const {digest: configDigest} = treatmentConfigOf(context, treatment);
		const artifact = artifacts.get(treatment.id) ?? null;

		treatmentContexts.set(treatment.id, {surface, configDigest});

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
	const campaignId = `${suite.id}-${identityDigest.slice(0, 16)}`;
	const randomizationSeed = identityDigest;
	const modelIdentity = modelIdentityOf(suite.model, environment);
	const environmentFacts = {...hostFactsOf(), referenceMachine: environment?.host.referenceMachine ?? os.hostname()};
	const manifest = {
		recordType: 'manifest',
		schemaVersion: EXECUTION_SCHEMA_VERSION,
		campaignId,
		claimClass: 'none',
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

	ensureManifestAt(path.join(runDir, 'manifest.json'), manifest);
	writeJsonAtomic(path.join(runDir, 'run.json'), {...manifest, status: 'running'}, true);

	const results: RunResultType[] = [];
	const budgetStartedAt = Date.now();
	const budgetDeadline = options.budgetMs === undefined ? null : budgetStartedAt + options.budgetMs;
	let budgetExceeded = false;

	try {
		for (const [index, entry] of plan.entries()) {
			const testCase = selected.find((item) => item.id === entry.caseId);

			if (testCase === undefined) {
				throw new Error(`unknown case ${entry.caseId}`);
			}

			if (budgetDeadline !== null && Date.now() >= budgetDeadline) {
				budgetExceeded = true;
				process.stderr.write(`budget exceeded before ${entry.caseId} ${entry.treatment} rep-${entry.repetition}; abandoning the remaining slots\n`);
				break;
			}

			const treatment = resolveTreatmentOf(entry, treatments);
			const treatmentContext = treatmentContexts.get(treatment.id);

			if (treatmentContext === undefined) {
				throw new Error(`no captured surface for treatment ${treatment.id}`);
			}

			const acceptedRef: ArtifactRefType | null = artifactRefOf(artifacts.get('accepted') ?? null);
			const candidateRef: ArtifactRefType | null = artifactRefOf(artifacts.get('candidate') ?? null);
			const executionIdentity = executionIdentityOf({
				suite,
				testCase,
				model: suite.model,
				treatment,
				surface: treatmentContext.surface,
				subject: {
					mode: subject.mode,
					revision: subject.revision,
					contentManifestHash: subject.contentManifestHash,
					lockFileHash: subject.lockFileHash,
				},
				artifacts: {accepted: acceptedRef, candidate: candidateRef},
				configDigest: treatmentContext.configDigest,
				repetitionIndex: entry.repetition,
				randomizationSeed,
				harnessVersion: HARNESS_VERSION,
				environment,
			});
			const slotIdentityDigest = executionIdentityDigestOf(executionIdentity);
			const slotDirectory = path.join(runDir, entry.caseId, entry.treatment, `rep-${entry.repetition}`);
			const resume = resumeStateOf(slotDirectory, slotIdentityDigest);

			if (flags.has('resume') && resume.record !== null) {
				process.stderr.write(`[${index + 1}/${plan.length}] ${entry.caseId} ${entry.treatment} rep-${entry.repetition} resumed attempt ${resume.attempt}\n`);
				results.push(resume.record);
				continue;
			}

			// Reject, never silently repair: a dirty or mismatched workspace would
			// mean the execution observes content the suite did not pin.
			const verification = assertCheckout(context, treatment);

			process.stderr.write(`[${index + 1}/${plan.length}] ${entry.caseId} ${entry.treatment} rep-${entry.repetition}\n`);

			const attemptResults: RunResultType[] = [];
			const execution = await runOnce({
				cwd: context.workspacePath(treatment.id),
				testCase,
				treatment,
				surface: treatmentContext.surface,
				repetition: entry.repetition,
				model: suite.model,
				revision: suite.revision,
				campaignId,
				identity: executionIdentity,
				identityDigest: slotIdentityDigest,
				clientStore,
				isolation: {
					mode: subject.mode,
					clientStore: clientStore.mode,
					checkoutClean: verification.checkoutClean,
					revisionMatch: verification.revisionMatch,
				},
				artifacts: runArtifactsOf(artifacts, treatment),
				rawBase: path.join(slotDirectory, 'raw'),
				firstAttempt: resume.nextAttempt,
				...(budgetDeadline === null ? {} : {timeoutMs: Math.max(1, budgetDeadline - Date.now())}),
				onAttempt: (attemptResult) => {
					attemptResults.push(attemptResult);
				},
			});
			const result = withRestoration(execution, restoreWorkspace(context, treatment));

			if (result.attempts.length > 1) {
				process.stderr.write(`  retried ${result.attempts.length - 1} time(s); last reason ${result.invalidReason ?? 'accepted'}\n`);
			}

			for (const [attemptIndex, attemptResult] of attemptResults.entries()) {
				const stored = attemptIndex === attemptResults.length - 1 ? result : attemptResult;

				writeResult(resultPathOf(slotDirectory, stored.attempt), stored);
			}

			results.push(result);

			if (!result.isolation.restored) {
				throw new Error(
					`restoration failed for ${treatment.id} after ${entry.caseId} rep-${entry.repetition}: ${result.invalidReason ?? 'unknown'}; the campaign stopped so no later execution observes edited content`,
				);
			}

			if (index < plan.length - 1) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, PACE_MS);
				});
			}
		}
	} catch (error) {
		writeJsonAtomic(
			path.join(runDir, 'run.json'),
			{
				...manifest,
				status: 'failed',
				failure: error instanceof Error ? error.message : String(error),
				finishedAt: new Date().toISOString(),
			},
			true,
		);

		throw error;
	}

	const elapsedMs = Date.now() - budgetStartedAt;
	const budget = options.budgetMs === undefined ? null : {budgetMs: options.budgetMs, elapsedMs, exceeded: budgetExceeded || elapsedMs > options.budgetMs};

	if (budget?.exceeded === true) {
		process.stderr.write(`budget exceeded after ${elapsedMs} ms of ${options.budgetMs} ms\n`);
	}

	// Calibration writes its own qualification decision. The ordinary paired
	// report requires treatment-identical agent surfaces, which calibration
	// intentionally does not have because accepted adds native MCP tools.
	const comparison = options.budgetMs !== undefined || results.length === 0 ? null : compare(results, manifest);

	if (comparison !== null) {
		writeJsonAtomic(path.join(runDir, 'report.json'), comparison, true);
	}

	writeJsonAtomic(
		path.join(runDir, 'run.json'),
		{...manifest, status: budget?.exceeded === true ? 'incomplete' : 'complete', budget, finishedAt: new Date().toISOString()},
		true,
	);

	if (comparison !== null) {
		printSummary(runDir, results, comparison);
	}

	return {runDir, results, comparison, budget};
};

const printSummary = (runDir: string, results: readonly RunResultType[], comparison: ReturnType<typeof compare>): void => {
	process.stdout.write(`results ${runDir}\n`);
	process.stdout.write(
		`report ${comparison.campaign.campaignId} schema=${comparison.schemaVersion} suite=${comparison.campaign.suite.id}@${comparison.campaign.suite.version} claim=${comparison.campaign.claimClass}\n`,
	);
	process.stdout.write(`runs ${results.length}, valid ${results.filter((run) => run.valid).length}, sources ${comparison.sources.identityDigests.length}\n`);

	for (const [name, summary] of [
		['no-index', comparison.noIndex],
		['accepted', comparison.accepted],
		['candidate', comparison.candidate],
	] as const) {
		const tokens = summary.statistics.tokens;
		const tokenText = tokens.state === 'exact' ? tokens.median.toFixed(0) : tokens.state;

		process.stdout.write(
			`${name.padEnd(9)} success ${(summary.successRate * 100).toFixed(1)}%  index-use ${(summary.indexUsageRate * 100).toFixed(0)}%  tokens ${tokenText} (n=${tokens.sampleCount})  calls ${summary.medianToolCalls.toFixed(1)}  bytes ${summary.medianOutputBytes.toFixed(0)}  p95 ${(summary.p95WallMs / 1000).toFixed(1)}s (n=${summary.statistics.wallTimeMs.sampleCount})  invalid ${summary.invalidRuns}  retried ${summary.retriedRuns}  execute ${summary.executeRuns}  unknown ${summary.unknownToolRuns}\n`,
		);
	}

	for (const threshold of comparison.thresholds) {
		process.stdout.write(`${threshold.passed ? 'PASS' : 'FAIL'} ${threshold.name} (${threshold.detail})\n`);
	}

	for (const report of comparison.classes) {
		process.stdout.write(
			`class ${report.class.padEnd(14)} cases ${report.caseIds.length}  candidate success ${(report.candidate.successRate * 100).toFixed(1)}%  bytes ${report.candidate.statistics.retrievalBytes.median.toFixed(0)}  calls ${report.candidate.statistics.toolCalls.median.toFixed(1)}  p95 ${(report.candidate.statistics.wallTimeMs.p95 / 1000).toFixed(1)}s (n=${report.candidate.statistics.wallTimeMs.sampleCount})  ${report.passed ? 'PASS' : 'NOT PASSED'}\n`,
		);
	}

	process.stdout.write(`Q2 ${comparison.passed ? 'PASSED' : 'NOT PASSED'}\n`);
};

const resultsIn = (directory: string, campaignId: string): readonly RunResultType[] => {
	const bySlot = new Map<string, Readonly<{attempt: number; record: StoredResultType}>>();
	const validByIdentity = new Map<string, number>();

	const walk = (current: string): void => {
		for (const entry of readdirSync(current)) {
			const full = path.join(current, entry);

			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}

			const match = /^attempt-(\d+)\.json$/.exec(entry);

			if (match === null) {
				continue;
			}

			const record = readResult(full);

			if (record === null || effectiveValidityOf(record) !== 'valid') {
				continue;
			}

			if (record.campaignId !== campaignId) {
				throw new Error(`attempt ${full} belongs to campaign ${record.campaignId}, not ${campaignId}`);
			}

			const validCount = (validByIdentity.get(record.identityDigest) ?? 0) + 1;

			if (validCount > 1) {
				throw new Error(`two effectively valid attempts exist for identity ${record.identityDigest}; the campaign is not reportable`);
			}

			validByIdentity.set(record.identityDigest, validCount);

			const attempt = Number(match[1]);
			const stored = bySlot.get(current);

			if (stored === undefined || attempt > stored.attempt) {
				bySlot.set(current, {attempt, record});
			}
		}
	};

	walk(directory);

	return [...bySlot.values()].map((entry) => entry.record);
};

const reportCommand = (flags: Map<string, string[]>): void => {
	const runId = flagOf(flags, 'run');
	const resultsRoot = path.join(evaluationRoot, 'results');
	const directory = runId === undefined ? latestRun(resultsRoot) : path.join(resultsRoot, runId);

	if (!existsSync(directory)) {
		throw new Error(`no results at ${directory}`);
	}

	const metadata = manifestMetadataOf(directory);
	const results = resultsIn(directory, metadata.campaignId);

	printSummary(directory, results, compare(results, metadata));
};

const latestRun = (resultsRoot: string): string => {
	const entries = existsSync(resultsRoot) ? readdirSync(resultsRoot).sort() : [];
	const last = entries.at(-1);

	if (last === undefined) {
		throw new Error('no runs recorded');
	}

	return path.join(resultsRoot, last);
};

const checkCommand = (flags: Map<string, string[]>): void => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(evaluationRoot, {subjectRepo: settings.subjectRepo, subject});
	const treatments = canonicalTreatmentsOf(suite.treatments);

	ensureWorkspaces(context, treatments);
	const artifacts = artifactsOf(context, treatments);
	const classes = new Set(cases.map((item) => item.class));

	process.stdout.write(`suite ${suite.id} v${suite.version}, ${cases.length} case(s), classes ${[...classes].join(', ')}\n`);
	process.stdout.write(`model ${suite.model}, revision ${suite.revision}\n`);
	process.stdout.write(`treatments ${treatmentIdsOf(suite.treatments).join(', ')}\n`);
	process.stdout.write(`ordinary tools ${suite.treatments[0]?.ordinaryTools.join(', ') ?? 'none'}\n`);
	process.stdout.write(
		`subject ${subject.mode}, revision ${subject.revision ?? subject.declaredRevision}, content ${subject.contentManifestHash}, lock ${subject.lockFileHash ?? 'none'}\n`,
	);

	for (const treatment of treatments) {
		const artifact = artifacts.get(treatment.id) ?? null;

		process.stdout.write(`artifact ${treatment.id} ${artifact === null ? 'none' : `${artifact.id} ${artifact.digest} (${artifact.fileCount} files)`}\n`);
	}

	process.stdout.write(`workspaces ready at the pinned subject\n`);
};

const routeTreatmentIdsOf = (value: string | undefined, treatments: readonly TreatmentDefinitionType[]): readonly RouteTreatmentType[] =>
	treatmentsOf(value, treatments)
		.map((treatment) => treatment.id)
		.filter((id): id is RouteTreatmentType => (ROUTE_TREATMENTS as readonly string[]).includes(id));

const stepSummaryOf = (step: ReturnType<typeof loadRoutePlan>['routes'][number]['codeindex'][number]): string =>
	step.kind === 'mcp'
		? `mcp ${step.tool} ${JSON.stringify(step.arguments)}`
		: step.kind === 'search'
			? `search ${step.pattern} in ${step.path}`
			: `read ${step.path}`;

const sessionKeyOf = (treatment: RouteTreatmentType, projectFile: string | undefined): string => `${treatment}::${projectFile ?? ''}`;

const openRouteSession = async (
	context: ReturnType<typeof workspaceContextOf>,
	treatment: TreatmentDefinitionType,
	projectFile: string | undefined,
): Promise<Awaited<ReturnType<typeof openMcpSession>>> =>
	openMcpSession({
		entryPoint: context.artifactPath(treatment),
		cwd: context.workspacePath(treatment.id),
		...(projectFile === undefined ? {} : {env: {CODE_INDEX_PROJECT_FILE: projectFile}}),
	});

const routeOutputOf = (flags: Map<string, string[]>, suiteId: string, planHash: string): string => {
	const explicit = flagOf(flags, 'output');

	if (explicit !== undefined) {
		return path.resolve(evaluationRoot, explicit);
	}

	const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');

	return path.join(evaluationRoot, 'results', 'route', `${suiteId}-${planHash.slice(0, 16)}-${stamp}`);
};

const routeCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const planPath = path.resolve(evaluationRoot, flagOf(flags, 'plan') ?? path.join('routes', `${suite.id}.json`));
	const plan = loadRoutePlan(planPath);

	validateRoutePlan(plan, suite, cases);

	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});
	const routes = new Map(plan.routes.map((route) => [route.caseId, route]));
	const treatmentIds = routeTreatmentIdsOf(flagOf(flags, 'treatment'), suite.treatments);
	const planHash = routePlanHashOf(plan);

	process.stdout.write(`route plan ${plan.id} ${planHash}\n`);
	process.stdout.write(`suite ${suite.id} v${suite.version} (${suite.status}) revision ${suite.revision}\n`);
	process.stdout.write(`treatments ${treatmentIds.join(', ')}\n`);

	if (flags.has('dry-run')) {
		for (const testCase of selected) {
			const route = routes.get(testCase.id);

			if (route === undefined) {
				throw new Error(`no route declared for ${testCase.id}`);
			}

			process.stdout.write(`  ${testCase.id}\n`);
			process.stdout.write(`    text: ${route.text.map((step) => stepSummaryOf(step)).join(' -> ')}\n`);
			process.stdout.write(`    codeindex: ${route.codeindex.map((step) => stepSummaryOf(step)).join(' -> ')}\n`);
		}

		return;
	}

	const treatments = treatmentsOf(flagOf(flags, 'treatment'), suite.treatments);
	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(evaluationRoot, {subjectRepo: settings.subjectRepo, subject});

	ensureWorkspaces(context, treatments);

	const artifacts = new Map<TreatmentIdType, ArtifactIdentityType | null>();

	for (const treatment of treatments) {
		artifacts.set(treatment.id, treatment.artifact === null ? null : artifactIdentityOf(context.artifactRoot(treatment), treatment));
	}

	const sessions = new Map<string, Awaited<ReturnType<typeof openMcpSession>>>();
	const runs: RouteRunType[] = [];
	const contract: Partial<Record<'accepted' | 'candidate', Awaited<ReturnType<typeof runContractProbes>>>> = {};

	try {
		for (const treatment of treatments) {
			if (treatment.kind === 'no-index') {
				continue;
			}

			const session = await openRouteSession(context, treatment, undefined);

			process.stderr.write(`artifact ${treatment.id} ${session.serverName} ${session.serverVersion} startup ${session.startupMs.toFixed(0)} ms\n`);
			sessions.set(sessionKeyOf(treatment.id as RouteTreatmentType, undefined), session);
		}

		for (const testCase of selected) {
			const route = routes.get(testCase.id);

			if (route === undefined) {
				throw new Error(`no route declared for ${testCase.id}`);
			}

			for (const treatment of treatmentIds) {
				const definition = treatments.find((item) => item.id === treatment);
				const key = sessionKeyOf(treatment, route.projectFile);
				let client = treatment === 'no-index' ? null : (sessions.get(key) ?? null);

				if (treatment !== 'no-index' && client === null && definition !== undefined) {
					client = await openRouteSession(context, definition, route.projectFile);
					sessions.set(key, client);
					process.stderr.write(
						`${treatment} project ${route.projectFile ?? 'root'} ${client.serverName} ${client.serverVersion} startup ${client.startupMs.toFixed(0)} ms\n`,
					);
				}

				const run = await runRoute({
					caseId: testCase.id,
					treatment,
					steps: treatment === 'no-index' ? route.text : route.codeindex,
					workspace: context.workspacePath(treatment),
					expectedFiles: testCase.expectedFiles,
					client,
					awaitIndexReady: treatment !== 'no-index',
				});

				runs.push(run);
				process.stderr.write(
					`${testCase.id} ${treatment} ${run.valid && run.exact ? 'exact' : 'MISS'} calls ${run.metrics.callCount} bytes ${run.metrics.responseBytes} core ${run.metrics.coreMs.state}${run.defects.length === 0 ? '' : ` (${run.defects.join('; ')})`}\n`,
				);
			}
		}

		for (const treatment of treatments) {
			if (treatment.kind === 'no-index' || !treatmentIds.includes(treatment.id as RouteTreatmentType)) {
				continue;
			}

			const session = sessions.get(sessionKeyOf(treatment.id as RouteTreatmentType, undefined));

			if (session === undefined) {
				continue;
			}

			const treatmentId = treatment.id as 'accepted' | 'candidate';
			const probes = await runContractProbes({
				session,
				openSession: (env) =>
					openMcpSession({
						entryPoint: context.artifactPath(treatment),
						cwd: context.workspacePath(treatment.id),
						env,
					}),
				workspace: context.workspacePath(treatment.id),
				plan: plan.contract,
				restore: () => {
					const restored = restoreWorkspace(context, treatment);

					if (!restored.restored) {
						throw new Error(`failed to restore ${treatment.id} after the stale-file probe: ${restored.reason ?? 'unknown reason'}`);
					}
				},
			});

			contract[treatmentId] = probes;
			process.stderr.write(`${treatment.id} contract ${probes.map((probe) => `${probe.kind}=${probe.result}`).join(' ')}\n`);
		}
	} finally {
		for (const session of sessions.values()) {
			await session.close();
		}
	}

	const routeCases: RouteCaseReportType[] = selected.map((testCase) => {
		const byTreatment: Partial<Record<RouteTreatmentType, RouteRunType>> = {};

		for (const treatment of treatmentIds) {
			const run = runs.find((item) => item.caseId === testCase.id && item.treatment === treatment);

			if (run !== undefined) {
				byTreatment[treatment] = run;
			}
		}

		return {
			caseId: testCase.id,
			class: testCase.class,
			expectedFiles: testCase.expectedFiles,
			treatments: byTreatment,
			answerEquality: treatmentIds.every((treatment) => byTreatment[treatment]?.valid === true && byTreatment[treatment]?.exact === true),
		};
	});
	const report = routeReportOf({
		generatedAt: new Date().toISOString(),
		suite: {id: suite.id, version: suite.version, status: suite.status, hash: suite.hash, revision: suite.revision},
		plan: {id: plan.id, hash: planHash},
		subject: {mode: subject.mode, revision: subject.revision, contentManifestHash: subject.contentManifestHash},
		artifacts: {
			accepted: artifactRefOf(artifacts.get('accepted') ?? null),
			candidate: artifactRefOf(artifacts.get('candidate') ?? null),
		},
		cases: routeCases,
		runs,
		contract,
		treatments: treatmentIds,
	});
	const output = routeOutputOf(flags, suite.id, planHash);

	writeJsonAtomic(path.join(output, 'report.json'), report);
	process.stdout.write(`report ${path.join(output, 'report.json')}\n`);

	for (const treatment of treatmentIds) {
		const summary = report.summaries[treatment];

		if (summary === undefined) {
			continue;
		}

		process.stdout.write(
			`${treatment.padEnd(9)} exact ${summary.exactCount}/${summary.caseCount}  calls ${summary.medianCallCount.toFixed(1)}  bytes ${summary.medianResponseBytes.toFixed(0)}  elapsed ${summary.medianElapsedMs.toFixed(0)} ms  core ${summary.coreMs.state}${summary.coreMs.value === null ? '' : ` ${summary.coreMs.value.toFixed(0)} ms`}\n`,
		);
	}

	for (const gate of report.gates) {
		process.stdout.write(`${gate.result.toUpperCase()} ${gate.id} (${gate.detail})\n`);
	}

	process.stdout.write(`E1 ${report.passed ? 'PASSED' : 'NOT PASSED'}\n`);
};

const {command, flags} = argsOf(process.argv.slice(2));

try {
	if (command === 'evaluate') {
		await evaluateCommand(flags);
	} else if (command === 'smoke') {
		await smokeCommand(flags);
	} else if (command === 'calibrate') {
		await calibrationCommand(flags);
	} else if (command === 'environment') {
		await environmentCommand(flags);
	} else if (command === 'route') {
		await routeCommand(flags);
	} else if (command === 'report') {
		reportCommand(flags);
	} else if (command === 'check') {
		checkCommand(flags);
	} else if (command === 'list') {
		listCommand(flags);
	} else {
		process.stdout.write(
			'usage: cli.ts <evaluate|smoke|calibrate|environment|route|report|check|list> --suite <path> [--environment <path>] [--budget-ms n] [--plan <path>] [--case id] [--tag tag] [--treatment all|no-index|accepted|candidate] [--repetitions n] [--dry-run] [--resume] [--campaign-store path] [--output dir]\n',
		);
		process.exitCode = command === 'help' ? 0 : 2;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
