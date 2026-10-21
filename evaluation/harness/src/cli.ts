import {existsSync, mkdirSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {artifactIdentityOf, artifactRefOf, type ArtifactIdentityType, type ArtifactRefType} from './artifact.ts';
import {EXECUTION_SCHEMA_VERSION, comparisonDigestOf, executionIdentityDigestOf, executionIdentityOf, identityDigestOf, identityOf} from './identity.ts';
import {campaignStoreRecordOf, clientStoreOf, isolationRecordOf, prepareClientStore, type ClientStoreType} from './isolation.ts';
import {catalogOf} from './mcp.ts';
import {compare, type ReportMetadataType} from './report.ts';
import {effectiveValidityOf, readResult, resultPathOf, resumeStateOf, writeJsonAtomic, writeResult, type StoredResultType} from './result.ts';
import {runOnce, withRestoration, type RunArtifactsType, type RunResultType} from './runner.ts';
import {caseHashOf} from './schema.ts';
import {loadSuite, planHashOf, planOf, resolveTreatmentOf, selectCases, treatmentIdsOf} from './suite.ts';
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

const evaluateCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});
	const treatments = treatmentsOf(flagOf(flags, 'treatment'), suite.treatments);
	const repetitions = Number(flagOf(flags, 'repetitions') ?? suite.repetitions);
	const plan = planOf(selected, treatmentIdsOf(treatments), repetitions);
	const planHash = planHashOf(plan);
	const identity = identityOf({
		suite,
		cases: selected,
		treatments: suite.treatments,
		repetitions,
		planHash,
		harnessVersion: HARNESS_VERSION,
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
	process.stderr.write(
		`isolation ${subject.mode}, ${pinned}, standalone server, client store ${clientStore.mode}${clientStore.path === null ? '' : ` at ${clientStore.path}`}\n`,
	);

	if (flags.has('dry-run')) {
		for (const entry of plan) {
			process.stderr.write(`  ${entry.caseId} ${entry.treatment} rep-${entry.repetition}\n`);
		}

		return;
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
		model: suite.model,
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

	try {
		for (const [index, entry] of plan.entries()) {
			const testCase = selected.find((item) => item.id === entry.caseId);

			if (testCase === undefined) {
				throw new Error(`unknown case ${entry.caseId}`);
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

	const comparison = compare(results, manifest);
	writeJsonAtomic(path.join(runDir, 'report.json'), comparison, true);
	writeJsonAtomic(path.join(runDir, 'run.json'), {...manifest, status: 'complete', finishedAt: new Date().toISOString()}, true);

	printSummary(runDir, results, comparison);
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

const {command, flags} = argsOf(process.argv.slice(2));

try {
	if (command === 'evaluate') {
		await evaluateCommand(flags);
	} else if (command === 'report') {
		reportCommand(flags);
	} else if (command === 'check') {
		checkCommand(flags);
	} else if (command === 'list') {
		listCommand(flags);
	} else {
		process.stdout.write(
			'usage: cli.ts <evaluate|report|check|list> --suite <path> [--case id] [--tag tag] [--treatment all|no-index|accepted|candidate] [--repetitions n] [--dry-run] [--resume] [--campaign-store path]\n',
		);
		process.exitCode = command === 'help' ? 0 : 2;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
