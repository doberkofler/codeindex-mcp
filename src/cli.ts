import {existsSync, mkdirSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {artifactIdentityOf, artifactRefOf, type ArtifactIdentityType} from './artifact.ts';
import {comparisonDigestOf, identityDigestOf, identityOf} from './identity.ts';
import {
	campaignStoreRecordOf,
	clientStoreOf,
	isolationRecordOf,
	prepareClientStore,
	type ClientStoreType,
} from './isolation.ts';
import {catalogOf} from './mcp.ts';
import {compare} from './report.ts';
import {runOnce, withRestoration, writeResult, type RunArtifactsType, type RunResultType} from './runner.ts';
import {loadSuite, planHashOf, planOf, resolveTreatmentOf, selectCases, treatmentIdsOf} from './suite.ts';
import {
	canonicalTreatmentsOf,
	toolSurfaceOf,
	treatmentDifferencesOf,
	type ToolSurfaceType,
	type TreatmentDefinitionType,
	type TreatmentIdType,
} from './treatment.ts';
import {
	assertCheckout,
	ensureWorkspaces,
	restoreWorkspace,
	subjectIdentityOf,
	treatmentConfigOf,
	workspaceContextOf,
} from './workspace.ts';

/** Harness schema version recorded in every run identity. */
const HARNESS_VERSION = 7;

/** Pause between executions to stay inside the provider's rolling window. */
const PACE_MS = Number(process.env['EVAL_PACE_MS'] ?? 5_000);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
	const file = path.join(root, 'harness.json');

	if (!existsSync(file)) {
		throw new Error(`missing ${file}`);
	}

	const parsed = JSON.parse(readFileSync(file, 'utf8')) as {subjectRepo?: unknown};

	if (typeof parsed.subjectRepo !== 'string') {
		throw new Error('harness.json must declare "subjectRepo"');
	}

	return {subjectRepo: parsed.subjectRepo};
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

type SurfaceMapType = ReadonlyMap<TreatmentIdType, ToolSurfaceType>;

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
const artifactsOf = (
	context: ReturnType<typeof workspaceContextOf>,
	treatments: readonly TreatmentDefinitionType[],
): ArtifactMapType => {
	const artifacts = new Map<TreatmentIdType, ArtifactIdentityType | null>();

	for (const treatment of treatments) {
		artifacts.set(
			treatment.id,
			treatment.artifact === null ? null : artifactIdentityOf(context.artifactRoot(treatment), treatment),
		);
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
const runArtifactsOf = (
	artifacts: ArtifactMapType,
	treatment: TreatmentDefinitionType,
): RunArtifactsType => ({
	accepted: artifactRefOf(artifacts.get('accepted') ?? null),
	candidate: artifactRefOf(artifacts.get('candidate') ?? null),
	loaded: artifactRefOf(artifacts.get(treatment.id) ?? null),
});

const listCommand = (flags: Map<string, string[]>): void => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(root, suitePath));
	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});

	process.stdout.write(
		`${suite.id} v${suite.version} schema=${suite.schemaVersion} (${suite.status}) model=${suite.model} revision=${suite.revision}\n`,
	);
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

	const {suite, cases} = loadSuite(path.resolve(root, suitePath));
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
	const runDir = path.join(root, 'results', `${suite.id}-${identityDigest.slice(0, 16)}`);
	const campaignStoreFlag = flagOf(flags, 'campaign-store');
	const clientStore: ClientStoreType = clientStoreOf({
		campaignStore: campaignStoreFlag === undefined ? null : campaignStoreFlag === 'true' ? '' : campaignStoreFlag,
		campaignDir: runDir,
	});

	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(root, {subjectRepo: settings.subjectRepo, subject});
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

	const manifestTreatments = canonicalTreatmentsOf(treatments).map((treatment) => {
		const surface = surfaces.get(treatment.id);

		if (surface === undefined) {
			throw new Error(`treatment ${treatment.id} has no captured tool surface`);
		}

		const {digest: configDigest} = treatmentConfigOf(context, treatment);
		const artifact = artifacts.get(treatment.id) ?? null;

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
	const manifest = {
		schemaVersion: suite.schemaVersion,
		suite: {id: suite.id, version: suite.version, status: suite.status, hash: suite.hash},
		harness: HARNESS_VERSION,
		identity,
		identityDigest,
		comparisonDigest,
		model: suite.model,
		revision: suite.revision,
		repetitions,
		planHash,
		plan,
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

	writeResult(path.join(runDir, 'run.json'), {...manifest, status: 'running'});

	const results: RunResultType[] = [];

	try {
		for (const [index, entry] of plan.entries()) {
			const testCase = selected.find((item) => item.id === entry.caseId);

			if (testCase === undefined) {
				throw new Error(`unknown case ${entry.caseId}`);
			}

			const treatment = resolveTreatmentOf(entry, treatments);
			const surface = surfaces.get(treatment.id);

			if (surface === undefined) {
				throw new Error(`no captured surface for treatment ${treatment.id}`);
			}

			const file = path.join(runDir, entry.caseId, entry.treatment, `rep-${entry.repetition}.json`);

			if (flags.has('resume') && existsSync(file)) {
				const stored = JSON.parse(readFileSync(file, 'utf8')) as RunResultType;

				if (stored.identityHash === identityDigest && stored.treatmentDefinitionHash === treatment.definitionHash) {
					results.push(stored);
					continue;
				}
			}

			// Reject, never silently repair: a dirty or mismatched workspace would
			// mean the execution observes content the suite did not pin.
			const verification = assertCheckout(context, treatment);

			process.stderr.write(`[${index + 1}/${plan.length}] ${entry.caseId} ${entry.treatment} rep-${entry.repetition}\n`);

			const execution = await runOnce({
				cwd: context.workspacePath(treatment.id),
				testCase,
				treatment,
				surface,
				repetition: entry.repetition,
				model: suite.model,
				revision: suite.revision,
				identityHash: identityDigest,
				clientStore,
				isolation: {
					mode: subject.mode,
					clientStore: clientStore.mode,
					checkoutClean: verification.checkoutClean,
					revisionMatch: verification.revisionMatch,
				},
				artifacts: runArtifactsOf(artifacts, treatment),
				rawBase: path.join(runDir, 'raw', entry.caseId, entry.treatment, `rep-${entry.repetition}`),
			});
			const result = withRestoration(execution, restoreWorkspace(context, treatment));

			if (result.attempts.length > 1) {
				process.stderr.write(`  retried ${result.attempts.length - 1} time(s); last reason ${result.invalidReason ?? 'accepted'}\n`);
			}

			writeResult(file, result);
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
		writeResult(path.join(runDir, 'run.json'), {
			...manifest,
			status: 'failed',
			failure: error instanceof Error ? error.message : String(error),
			finishedAt: new Date().toISOString(),
		});

		throw error;
	}

	const comparison = compare(results);
	writeResult(path.join(runDir, 'report.json'), comparison);
	writeResult(path.join(runDir, 'run.json'), {...manifest, status: 'complete', finishedAt: new Date().toISOString()});

	printSummary(runDir, results, comparison);
};

const printSummary = (runDir: string, results: readonly RunResultType[], comparison: ReturnType<typeof compare>): void => {
	process.stdout.write(`results ${runDir}\n`);
	process.stdout.write(`runs ${results.length}, valid ${results.filter((run) => run.valid).length}\n`);

	for (const [name, summary] of [
		['no-index', comparison.noIndex],
		['accepted', comparison.accepted],
		['candidate', comparison.candidate],
	] as const) {
		process.stdout.write(
			`${name.padEnd(9)} success ${(summary.successRate * 100).toFixed(1)}%  index-use ${(summary.indexUsageRate * 100).toFixed(0)}%  tokens ${summary.medianTokens.toFixed(0)}  calls ${summary.medianToolCalls.toFixed(1)}  bytes ${summary.medianOutputBytes.toFixed(0)}  p95 ${(summary.p95WallMs / 1000).toFixed(1)}s  invalid ${summary.invalidRuns}  retried ${summary.retriedRuns}  execute ${summary.executeRuns}  unknown ${summary.unknownToolRuns}\n`,
		);
	}

	for (const threshold of comparison.thresholds) {
		process.stdout.write(`${threshold.passed ? 'PASS' : 'FAIL'} ${threshold.name} (${threshold.detail})\n`);
	}

	process.stdout.write(`Q2 ${comparison.passed ? 'PASSED' : 'NOT PASSED'}\n`);
};

const resultsIn = (directory: string): readonly RunResultType[] => {
	const results: RunResultType[] = [];

	const walk = (current: string): void => {
		for (const entry of readdirSync(current)) {
			const full = path.join(current, entry);

			if (statSync(full).isDirectory()) {
				walk(full);
			} else if (entry.endsWith('.json') && /^rep-\d+\.json$/.test(entry)) {
				results.push(JSON.parse(readFileSync(full, 'utf8')) as RunResultType);
			}
		}
	};

	walk(directory);

	return results;
};

const reportCommand = (flags: Map<string, string[]>): void => {
	const runId = flagOf(flags, 'run');
	const resultsRoot = path.join(root, 'results');
	const directory = runId === undefined ? latestRun(resultsRoot) : path.join(resultsRoot, runId);

	if (!existsSync(directory)) {
		throw new Error(`no results at ${directory}`);
	}

	const results = resultsIn(directory);
	printSummary(directory, results, compare(results));
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

	const {suite, cases} = loadSuite(path.resolve(root, suitePath));
	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(root, {subjectRepo: settings.subjectRepo, subject});
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

		process.stdout.write(
			`artifact ${treatment.id} ${artifact === null ? 'none' : `${artifact.id} ${artifact.digest} (${artifact.fileCount} files)`}\n`,
		);
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
