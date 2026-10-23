import {readFileSync} from 'node:fs';
import path from 'node:path';
import {assertCanonicalTreatmentOf, loadCanonicalArtifact, type CanonicalArtifactType} from './canonicalArtifact.ts';
import {evaluateCommand, type EvaluationRunType} from './cliEvaluate.ts';
import {HARNESS_VERSION, allOf, evaluationRoot, flagOf, manifestMetadataOf, manifestPathOf, verifiedEnvironmentOf} from './cliSupport.ts';
import {assertEnvironmentPurpose, loadEnvironmentManifest, type EnvironmentManifestType} from './environment.ts';
import {assertLocalClaimClass, LOCAL_CLAIM_CLASS} from './localContract.ts';
import {QUALIFICATION_CASE_COUNT, QUALIFICATION_EXECUTIONS, QUALIFICATION_REPETITIONS, QUALIFICATION_TREATMENT_IDS} from './qualificationContract.ts';
import {qualificationReportOf, qualificationSummaryOf} from './qualification.ts';
import {writeJsonAtomic} from './result.ts';
import {caseHashOf, type CaseType, type SuiteType} from './schema.ts';
import {loadSuite, planOf, treatmentIdsOf} from './suite.ts';
import {type TreatmentDefinitionType} from './treatment.ts';

/** Frozen release suite that supplies the qualification case corpus. */
const RELEASE_SUITE_PATH = 'suites/release.json';

/** Flags that would change the fixed 108-slot qualification plan or criteria. */
const FIXED_PLAN_FLAGS = ['case', 'tag', 'treatment', 'repetitions', 'target-metric'] as const;

/** Resolved frozen inputs for one qualification campaign. */
type QualificationInputsType = Readonly<{
	flags: Map<string, string[]>;
	suite: SuiteType;
	cases: readonly CaseType[];
	canonicalTreatment: TreatmentDefinitionType;
	canonical: CanonicalArtifactType;
	environment: EnvironmentManifestType;
}>;

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

const assertReleaseCorpusOf = (suite: SuiteType, cases: readonly CaseType[]): void => {
	const release = loadSuite(path.resolve(evaluationRoot, RELEASE_SUITE_PATH));

	if (release.suite.status !== 'frozen') {
		throw new Error(`qualification requires the frozen release suite; ${release.suite.id} is ${release.suite.status}`);
	}

	if (release.cases.length !== QUALIFICATION_CASE_COUNT) {
		throw new Error(
			`qualification requires the frozen ${QUALIFICATION_CASE_COUNT}-case release suite; ${release.suite.id} declares ${release.cases.length} case(s)`,
		);
	}

	if (suite.revision !== release.suite.revision) {
		throw new Error(`qualification suite revision ${suite.revision} differs from release suite revision ${release.suite.revision}`);
	}

	const releaseHashes = new Map(release.cases.map((testCase) => [testCase.id, caseHashOf(testCase)]));
	const caseIds = cases.map((testCase) => testCase.id).sort();

	if (caseIds.join(',') !== [...releaseHashes.keys()].sort().join(',')) {
		throw new Error('qualification suite must select exactly the frozen release case set');
	}

	for (const testCase of cases) {
		const pinned = releaseHashes.get(testCase.id);

		if (pinned === undefined || pinned !== caseHashOf(testCase)) {
			throw new Error(`qualification case ${testCase.id} differs from the frozen release case content`);
		}
	}
};

const qualificationInputsOf = (flags: Map<string, string[]>): QualificationInputsType => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined || suitePath === 'true') {
		throw new Error('--suite is required');
	}

	for (const forbidden of FIXED_PLAN_FLAGS) {
		if (flags.has(forbidden)) {
			throw new Error(`qualification does not accept --${forbidden}; the frozen qualification plan is fixed`);
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

	const canonicalPath = manifestPathOf(flags, 'canonical');
	const loaded = loadSuite(path.resolve(evaluationRoot, suitePath));

	if (loaded.suite.status !== 'frozen') {
		throw new Error(`suite ${loaded.suite.id} must be frozen for qualification`);
	}

	if (loaded.cases.length !== QUALIFICATION_CASE_COUNT) {
		throw new Error(
			`qualification requires the frozen ${QUALIFICATION_CASE_COUNT}-case suite; suite ${loaded.suite.id} declares ${loaded.cases.length} case(s)`,
		);
	}

	if (loaded.suite.repetitions !== QUALIFICATION_REPETITIONS) {
		throw new Error(`qualification requires ${QUALIFICATION_REPETITIONS} paired repetitions; suite ${loaded.suite.id} declares ${loaded.suite.repetitions}`);
	}

	const treatmentIds = treatmentIdsOf(loaded.suite.treatments);

	if (treatmentIds.join(',') !== QUALIFICATION_TREATMENT_IDS.join(',')) {
		throw new Error(
			`qualification requires treatments ${QUALIFICATION_TREATMENT_IDS.join(', ')}; suite ${loaded.suite.id} declares ${treatmentIds.join(', ')}`,
		);
	}

	const canonicalTreatment = loaded.suite.treatments.find((treatment) => treatment.id === 'canonical');

	if (canonicalTreatment === undefined) {
		throw new Error(`suite ${loaded.suite.id} declares no canonical treatment`);
	}

	const canonical = loadCanonicalArtifact(canonicalPath);

	assertCanonicalTreatmentOf(canonical, canonicalTreatment);
	assertReleaseCorpusOf(loaded.suite, loaded.cases);

	const environment = loadEnvironmentManifest(path.resolve(evaluationRoot, environmentPath));

	assertEnvironmentPurpose(environment, 'calibration');

	return {flags, suite: loaded.suite, cases: loaded.cases, canonicalTreatment, canonical, environment};
};

const optionsOf = (inputs: QualificationInputsType): Parameters<typeof evaluateCommand>[1] => {
	const budgetMs = budgetOf(inputs.flags);

	return {
		treatments: [...QUALIFICATION_TREATMENT_IDS],
		repetitions: QUALIFICATION_REPETITIONS,
		environment: inputs.environment,
		requireFrozen: true,
		model: inputs.environment.model.reference,
		claimClass: LOCAL_CLAIM_CLASS,
		comparison: false,
		...(budgetMs === undefined ? {} : {budgetMs}),
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const campaignManifestOf = (
	runDir: string,
): Readonly<{stagedCanonical: Readonly<{id: string; digest: string}>; subject: Readonly<{revision: string; contentManifestHash: string}>}> => {
	const file = path.join(runDir, 'manifest.json');
	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

	if (!isRecord(parsed)) {
		throw new TypeError(`campaign manifest at ${file} is not a JSON object`);
	}

	const {treatments, subject} = parsed;

	if (!Array.isArray(treatments)) {
		throw new TypeError(`campaign manifest at ${file} has no treatment records`);
	}

	const canonical: unknown = treatments.find((entry) => isRecord(entry) && entry['id'] === 'canonical');

	if (!isRecord(canonical)) {
		throw new Error(`campaign manifest at ${file} records no canonical artifact`);
	}

	const {artifact} = canonical;

	if (!isRecord(artifact)) {
		throw new Error(`campaign manifest at ${file} records no canonical artifact`);
	}

	const {id, digest} = artifact;

	if (typeof id !== 'string' || typeof digest !== 'string') {
		throw new TypeError(`campaign manifest at ${file} records an invalid canonical artifact`);
	}

	if (!isRecord(subject)) {
		throw new TypeError(`campaign manifest at ${file} records an invalid subject identity`);
	}

	const {revision, contentManifestHash} = subject;

	if (typeof revision !== 'string' || typeof contentManifestHash !== 'string') {
		throw new TypeError(`campaign manifest at ${file} records an invalid subject identity`);
	}

	return {
		stagedCanonical: {id, digest},
		subject: {revision, contentManifestHash},
	};
};

const printReportOf = (report: ReturnType<typeof qualificationReportOf>, runDir: string): void => {
	process.stdout.write(
		`local qualification ${report.status.toUpperCase()} claim=${report.claimClass} release-authority=${String(report.releaseAuthority)} frontier-gate=${report.frontierReleaseGate} model=${report.model.modelId} executions=${report.plan.validExecutions}/${report.plan.expectedExecutions}\n`,
	);

	for (const check of report.checks) {
		process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.id} expected ${check.expected} observed ${check.observed}\n`);
	}

	for (const reason of report.disqualification.reasons) {
		process.stdout.write(`DISQUALIFIED ${reason}\n`);
	}

	process.stdout.write(`${qualificationSummaryOf(report)}\n`);
	process.stdout.write(`record ${path.join(runDir, 'qualification.json')}\n`);
};

/**
 * Runs the independent fixed 108-slot local-model qualification campaign.
 *
 * The command compares only `no-index` and one digest-pinned canonical CodeIndex
 * artifact. The suite, subject revision, harness, canonical artifact, and plan
 * are fixed; only the pinned local environment changes across comparable
 * campaigns. It writes a local-model-scoped record with no release authority and
 * never reads or changes hosted release evidence.
 *
 * @param flags - Parsed CLI flags.
 */
export const qualificationCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = qualificationInputsOf(flags);
	const options = optionsOf(inputs);

	if (flags.has('dry-run')) {
		await evaluateCommand(flags, options);

		return;
	}

	process.stderr.write(`environment ${inputs.environment.id} verification\n`);
	await verifiedEnvironmentOf(inputs.environment);

	process.stderr.write(
		`qualification ${inputs.environment.model.reference}: ${QUALIFICATION_CASE_COUNT} case(s) x ${QUALIFICATION_TREATMENT_IDS.length} treatment(s) x ${QUALIFICATION_REPETITIONS} repetitions = ${QUALIFICATION_EXECUTIONS} executions\n`,
	);

	const run: EvaluationRunType | null = await evaluateCommand(flags, options);

	if (run === null) {
		return;
	}

	const metadata = manifestMetadataOf(run.runDir);

	assertLocalClaimClass(metadata.claimClass);

	const manifest = campaignManifestOf(run.runDir);
	const report = qualificationReportOf({
		suite: {id: metadata.suite.id, version: metadata.suite.version, hash: metadata.suite.hash},
		loadedSuite: inputs.suite,
		caseList: inputs.cases,
		canonical: inputs.canonical,
		stagedCanonical: manifest.stagedCanonical,
		environment: inputs.environment,
		subject: manifest.subject,
		harnessVersion: HARNESS_VERSION,
		campaignId: metadata.campaignId,
		claimClass: metadata.claimClass,
		expectedSlots: planOf(inputs.cases, [...QUALIFICATION_TREATMENT_IDS], QUALIFICATION_REPETITIONS),
		results: run.results,
	});

	writeJsonAtomic(path.join(run.runDir, 'qualification.json'), report, true);
	printReportOf(report, run.runDir);

	if (report.status !== 'qualified') {
		throw new Error(`local model did not qualify: ${report.disqualification.reasons.join('; ')}`);
	}
};
