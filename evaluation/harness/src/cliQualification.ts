import {readFileSync} from 'node:fs';
import path from 'node:path';
import {evaluateCommand, type EvaluationRunType} from './cliEvaluate.ts';
import {revalidationCommand} from './cliQualificationRevalidation.ts';
import {
	HARNESS_VERSION,
	allOf,
	evaluationRoot,
	flagOf,
	manifestMetadataOf,
	primaryCheckout,
	stateRootOutsidePrimaryOf,
	verifiedEnvironmentOf,
} from './cliSupport.ts';
import {EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {assertEnvironmentPurpose, loadEnvironmentManifest, type EnvironmentManifestType} from './environment.ts';
import {type ExecutionProviderMeterType} from './executionMeter.ts';
import {assertLocalClaimClass, LOCAL_CLAIM_CLASS} from './localContract.ts';
import {QUALIFICATION_REPETITIONS, QUALIFICATION_TREATMENT_IDS, type QualificationPreflightType} from './qualificationContract.ts';
import {commonQualificationInputsOf, type QualificationCommonInputsType} from './qualificationInputs.ts';
import {qualificationReportOf, qualificationSummaryOf} from './qualification.ts';
import {writeJsonAtomic} from './result.ts';
import {planOf} from './suite.ts';

/** Resolved frozen inputs for one qualification campaign. */
type QualificationInputsType = QualificationCommonInputsType &
	Readonly<{
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

const qualificationInputsOf = (flags: Map<string, string[]>): QualificationInputsType => {
	const common = commonQualificationInputsOf(flags);
	const environmentPaths = allOf(flags, 'environment');

	if (environmentPaths.length !== 1) {
		throw new Error('--environment is required exactly once');
	}

	const [environmentPath] = environmentPaths;

	if (environmentPath === undefined || environmentPath === 'true') {
		throw new Error('--environment is required');
	}

	const environment = loadEnvironmentManifest(path.resolve(evaluationRoot, environmentPath));

	assertEnvironmentPurpose(environment, 'calibration');

	return {...common, environment};
};

const providerMeterOf = (environment: EnvironmentManifestType): ExecutionProviderMeterType => {
	const separator = environment.model.reference.indexOf('/');
	const provider = separator === -1 ? '' : environment.model.reference.slice(0, separator);
	const modelId = separator === -1 ? '' : environment.model.reference.slice(separator + 1);

	if (provider.length === 0 || modelId.length === 0) {
		throw new Error(`environment model reference "${environment.model.reference}" must have the form <provider>/<model>`);
	}

	return {
		upstreamBaseUrl: environment.runtime.ollamaEndpoint,
		provider,
		modelId,
		forbiddenPaths: [primaryCheckout],
	};
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
		providerMeter: providerMeterOf(inputs.environment),
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

const stringsOf = (value: unknown, context: string): readonly string[] =>
	Array.isArray(value)
		? value.map((item, index) => {
				if (typeof item !== 'string') {
					throw new TypeError(`${context}[${index}] must be a string`);
				}

				return item;
			})
		: [];

const booleanOf = (value: unknown, context: string): boolean => {
	if (typeof value !== 'boolean') {
		throw new TypeError(`${context} must be a boolean`);
	}

	return value;
};

const symbolProbeOf = (value: unknown, context: string): QualificationPreflightType['cases'][number]['symbolProbe'] => {
	if (value === null || value === undefined) {
		return null;
	}

	if (!isRecord(value)) {
		throw new TypeError(`${context} must be an object or null`);
	}

	const {symbol, path: probePath, ok} = value;

	if (typeof symbol !== 'string' || typeof probePath !== 'string') {
		throw new TypeError(`${context} must name a symbol and path`);
	}

	return {symbol, path: probePath, ok: booleanOf(ok, `${context}.ok`)};
};

const preflightOf = (runDir: string): QualificationPreflightType => {
	const file = path.join(runDir, 'preflight.json');
	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

	if (!isRecord(parsed)) {
		throw new TypeError(`corpus preflight at ${file} is not a JSON object`);
	}

	const {result, cases, treatments, failures} = parsed;

	if (result !== 'pass' && result !== 'fail') {
		throw new TypeError(`corpus preflight at ${file} has no result`);
	}

	return {
		result,
		cases: (Array.isArray(cases) ? cases : [])
			.filter((item) => isRecord(item))
			.map((item, index) => {
				const {caseId, pathsPresent, symbolProbe} = item;

				if (typeof caseId !== 'string') {
					throw new TypeError(`corpus preflight case[${index}] has no id`);
				}

				return {
					caseId,
					pathsPresent: booleanOf(pathsPresent, `corpus preflight case[${index}].pathsPresent`),
					symbolProbe: symbolProbeOf(symbolProbe, `corpus preflight case[${index}].symbolProbe`),
				};
			}),
		treatments: (Array.isArray(treatments) ? treatments : [])
			.filter((item) => isRecord(item))
			.map((item, index) => {
				const {treatmentId} = item;

				if (typeof treatmentId !== 'string') {
					throw new TypeError(`corpus preflight treatment[${index}] has no id`);
				}

				const context = `corpus preflight treatment[${index}]`;

				return {
					treatmentId,
					ready: booleanOf(item['ready'], `${context}.ready`),
					filesIndexed: booleanOf(item['filesIndexed'], `${context}.filesIndexed`),
					rootMatches: booleanOf(item['rootMatches'], `${context}.rootMatches`),
					projectsConfigured: booleanOf(item['projectsConfigured'], `${context}.projectsConfigured`),
					missingPaths: stringsOf(item['missingPaths'], `${context}.missingPaths`),
					unindexedPaths: stringsOf(item['unindexedPaths'], `${context}.unindexedPaths`),
					failures: stringsOf(item['failures'], `${context}.failures`),
				};
			}),
		failures: stringsOf(failures, 'corpus preflight failures'),
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
 * `--revalidate` runs the same frozen inputs, canonical artifact, request-1
 * surface, corpus, metering, and isolation checks without calling a model and
 * writes a validity-only revalidation record.
 *
 * @param flags - Parsed CLI flags.
 */
export const qualificationCommand = async (flags: Map<string, string[]>): Promise<void> => {
	if (flags.has('revalidate')) {
		await revalidationCommand(flags);

		return;
	}

	const inputs = qualificationInputsOf(flags);
	const options = optionsOf(inputs);

	if (flags.has('dry-run')) {
		await evaluateCommand(flags, options);

		return;
	}

	process.stderr.write(`environment ${inputs.environment.id} verification\n`);
	await verifiedEnvironmentOf(inputs.environment);

	process.stderr.write(
		`qualification ${inputs.environment.model.reference}: ${inputs.cases.length} case(s) x ${QUALIFICATION_TREATMENT_IDS.length} treatment(s) x ${QUALIFICATION_REPETITIONS} repetitions\n`,
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
		contract: EVALUATION_CONTRACT_PIN,
		preflight: preflightOf(run.runDir),
		stateRootOutsideCheckout: stateRootOutsidePrimaryOf().passed,
		expectedSlots: planOf(inputs.cases, [...QUALIFICATION_TREATMENT_IDS], QUALIFICATION_REPETITIONS),
		results: run.results,
	});

	writeJsonAtomic(path.join(run.runDir, 'qualification.json'), report, true);
	printReportOf(report, run.runDir);

	if (report.status !== 'qualified') {
		throw new Error(`local model did not qualify: ${report.disqualification.reasons.join('; ')}`);
	}
};
