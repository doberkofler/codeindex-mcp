import path from 'node:path';
import {
	calibrationDecisionOf,
	calibrationDisqualificationOf,
	calibrationSelectionOf,
	type CalibrationDecisionType,
	type CalibrationExclusionType,
} from './calibration.ts';
import {DIAGNOSTIC_CASE_IDS, DIAGNOSTIC_REPETITIONS, DIAGNOSTIC_TREATMENT_IDS, diagnosticReportOf, diagnosticSummaryOf} from './diagnostics.ts';
import {assertEnvironmentPurpose, environmentHashOf, loadEnvironmentManifest, type EnvironmentManifestType} from './environment.ts';
import {hashOf} from './hash.ts';
import {writeJsonAtomic} from './result.ts';
import {loadSuite} from './suite.ts';
import {allOf, evaluationRoot, evaluationStateRoot, flagOf, verifiedEnvironmentOf} from './cliSupport.ts';
import {evaluateCommand} from './cliEvaluate.ts';

/** Declared wall-clock budget for one local-model calibration. */
const CALIBRATION_BUDGET_MS = 15 * 60 * 1000;

/** Frozen calibration subset size required by strategy §10. */
const CALIBRATION_CASE_COUNT = 6;

/** Treatments compared by a local calibration. */
const CALIBRATION_TREATMENTS = DIAGNOSTIC_TREATMENT_IDS;

export const calibrationBudgetOf = (flags: Map<string, string[]>): number => {
	const raw = flagOf(flags, 'budget-ms');
	const budgetMs = raw === undefined ? CALIBRATION_BUDGET_MS : Number(raw);

	if (!Number.isInteger(budgetMs) || budgetMs <= 0) {
		throw new Error('--budget-ms must be a positive integer');
	}

	return budgetMs;
};

/**
 * Parses `--exclude <environment-id>=<reason>` declarations.
 *
 * An excluded candidate is recorded as disqualified before any execution, so an
 * operator limit such as an unavailable model stays visible in the selection.
 *
 * @param flags - Parsed CLI flags.
 * @param environments - Declared calibration environments.
 * @returns Reason by environment id.
 */
export const exclusionsOf = (flags: Map<string, string[]>, environments: readonly EnvironmentManifestType[]): ReadonlyMap<string, string> => {
	const exclusions = new Map<string, string>();

	for (const value of allOf(flags, 'exclude')) {
		const separator = value.indexOf('=');
		const id = separator === -1 ? '' : value.slice(0, separator).trim();
		const reason = separator === -1 ? '' : value.slice(separator + 1).trim();

		if (id.length === 0 || reason.length === 0) {
			throw new Error('--exclude requires <environment-id>=<reason>');
		}

		if (!environments.some((environment) => environment.id === id)) {
			throw new Error(`--exclude names unknown environment ${id}`);
		}

		if (exclusions.has(id)) {
			throw new Error(`--exclude names ${id} more than once`);
		}

		exclusions.set(id, reason);
	}

	return exclusions;
};

/** Frozen calibration inputs resolved from the CLI and the suite file. */
type CalibrationInputsType = Readonly<{
	suite: ReturnType<typeof loadSuite>['suite'];
	caseCount: number;
	budgetMs: number;
	environments: readonly EnvironmentManifestType[];
	exclusions: ReadonlyMap<string, string>;
}>;

/** Mutable calibration state shared by the per-environment slots. */
type CalibrationContextType = Readonly<{
	flags: Map<string, string[]>;
	budgetMs: number;
	plannedSlots: number;
	exclusions: ReadonlyMap<string, string>;
	decisions: CalibrationDecisionType[];
	excluded: CalibrationExclusionType[];
}>;

const calibrationInputsOf = (flags: Map<string, string[]>): CalibrationInputsType => {
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

	const environments = environmentPaths.map((value) => loadEnvironmentManifest(path.resolve(evaluationRoot, value)));

	for (const environment of environments) {
		assertEnvironmentPurpose(environment, 'calibration');
	}

	if (new Set(environments.map((environment) => environment.model.reference)).size !== environments.length) {
		throw new Error('calibrate received the same model reference more than once');
	}

	return {suite, caseCount: cases.length, budgetMs: calibrationBudgetOf(flags), environments, exclusions: exclusionsOf(flags, environments)};
};

// Resolves a pre-execution exclusion; returns true when the model is excluded.
const exclusionSlotOf = (environment: EnvironmentManifestType, context: CalibrationContextType): boolean => {
	const exclusion = context.exclusions.get(environment.id);

	if (exclusion === undefined) {
		return false;
	}

	const model = environment.model.reference;
	const environmentHash = environmentHashOf(environment);

	context.excluded.push({model, environment: {id: environment.id, hash: environmentHash}, budgetMs: context.budgetMs, reason: exclusion});
	context.decisions.push(
		calibrationDisqualificationOf({
			model,
			environmentId: environment.id,
			environmentHash,
			budgetMs: context.budgetMs,
			plannedSlots: context.plannedSlots,
			reason: `excluded before execution: ${exclusion}`,
		}),
	);
	process.stdout.write(`EXCLUDED ${model} ${exclusion}\n`);

	return true;
};

// Runs the diagnostic contract; returns true when the model must not continue.
const diagnosticsSlotOf = async (environment: EnvironmentManifestType, context: CalibrationContextType): Promise<boolean> => {
	const model = environment.model.reference;
	const environmentHash = environmentHashOf(environment);

	process.stderr.write(
		`calibration diagnostics ${model}: ${DIAGNOSTIC_CASE_IDS.length} case(s) x ${CALIBRATION_TREATMENTS.length} treatment(s) x ${DIAGNOSTIC_REPETITIONS} repetition(s)\n`,
	);

	const diagnosticRun = await evaluateCommand(context.flags, {
		treatments: [...CALIBRATION_TREATMENTS],
		repetitions: DIAGNOSTIC_REPETITIONS,
		caseIds: [...DIAGNOSTIC_CASE_IDS],
		environment,
		requireFrozen: true,
		model,
		comparison: false,
	});

	if (diagnosticRun === null) {
		return true;
	}

	const diagnostics = diagnosticReportOf(diagnosticRun.results, DIAGNOSTIC_CASE_IDS, DIAGNOSTIC_REPETITIONS, CALIBRATION_TREATMENTS);
	const diagnosticRecord = {...diagnostics, model, environment: {id: environment.id, hash: environmentHash}};

	writeJsonAtomic(path.join(diagnosticRun.runDir, 'diagnostics.json'), diagnosticRecord, true);
	process.stdout.write(`DIAGNOSTICS ${model} ${diagnostics.passed ? 'CLEAN' : 'BLOCKED'} ${diagnosticSummaryOf(diagnostics)}\n`);

	if (diagnostics.passed) {
		return false;
	}

	// A blocked diagnostic contract disqualifies the candidate. Dropping it
	// would hide a failed candidate from the selection record.
	context.decisions.push(
		calibrationDisqualificationOf({
			model,
			environmentId: environment.id,
			environmentHash,
			budgetMs: context.budgetMs,
			plannedSlots: context.plannedSlots,
			reason: `diagnostics blocked: ${diagnosticSummaryOf(diagnostics)}`,
		}),
	);
	process.stdout.write(`diagnostics ${path.join(diagnosticRun.runDir, 'diagnostics.json')}\n`);

	return true;
};

const reportDecisionOf = (decision: CalibrationDecisionType): void => {
	process.stdout.write(
		`${decision.passed ? 'QUALIFIED' : 'DISQUALIFIED'} ${decision.model} valid ${decision.validExecutions}/${decision.plannedSlots} accepted-exact ${decision.acceptedExact} no-index-exact ${decision.noIndexExact} elapsed ${decision.elapsedMs} ms\n`,
	);

	if (decision.disqualification !== null) {
		process.stdout.write(`disqualification ${decision.disqualification}\n`);
	}

	if (decision.telemetry.limitation !== null) {
		process.stdout.write(`telemetry ${decision.telemetry.limitation}\n`);
	}
};

// Runs the frozen calibration plan for one verified environment.
const calibrationRunOf = async (environment: EnvironmentManifestType, context: CalibrationContextType): Promise<void> => {
	const model = environment.model.reference;
	const run = await evaluateCommand(context.flags, {
		treatments: [...CALIBRATION_TREATMENTS],
		repetitions: 1,
		environment,
		requireFrozen: true,
		model,
		budgetMs: context.budgetMs,
		comparison: false,
	});

	if (run === null) {
		return;
	}

	const decision = calibrationDecisionOf({
		model,
		environmentId: environment.id,
		environmentHash: environmentHashOf(environment),
		budgetMs: context.budgetMs,
		elapsedMs: run.budget?.elapsedMs ?? 0,
		plannedSlots: context.plannedSlots,
		results: run.results,
	});

	writeJsonAtomic(path.join(run.runDir, 'calibration.json'), decision, true);
	context.decisions.push(decision);
	reportDecisionOf(decision);
};

const runSlotOf = async (environment: EnvironmentManifestType, context: CalibrationContextType): Promise<void> => {
	if (exclusionSlotOf(environment, context)) {
		return;
	}

	if (await diagnosticsSlotOf(environment, context)) {
		return;
	}

	await calibrationRunOf(environment, context);
};

const writeSelectionOf = (suite: ReturnType<typeof loadSuite>['suite'], context: CalibrationContextType): void => {
	const selection = calibrationSelectionOf(context.decisions);
	const selectionDigest = hashOf({suite: suite.hash, budgetMs: context.budgetMs, decisions: context.decisions, excluded: context.excluded});
	const selectionDir = path.join(evaluationStateRoot, 'results', `${suite.id}-selection-${selectionDigest.slice(0, 16)}`);

	writeJsonAtomic(
		path.join(selectionDir, 'selection.json'),
		{
			recordType: 'calibration-selection',
			schemaVersion: 1,
			suite: {id: suite.id, version: suite.version, hash: suite.hash},
			budgetMs: context.budgetMs,
			selection,
			decisions: context.decisions,
			excluded: context.excluded,
		},
		true,
	);
	process.stdout.write(`selection ${selection.selected ?? 'none'} (${selection.reason})\n`);
	process.stdout.write(`record ${path.join(selectionDir, 'selection.json')}\n`);
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
export const calibrationCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = calibrationInputsOf(flags);
	const context: CalibrationContextType = {
		flags,
		budgetMs: inputs.budgetMs,
		plannedSlots: inputs.caseCount * CALIBRATION_TREATMENTS.length,
		exclusions: inputs.exclusions,
		decisions: [],
		excluded: [],
	};

	if (!flags.has('dry-run')) {
		for (const environment of inputs.environments) {
			if (context.exclusions.has(environment.id)) {
				continue;
			}

			process.stderr.write(`calibration environment ${environment.id} verification\n`);
			await verifiedEnvironmentOf(environment);
		}
	}

	process.stderr.write(
		`calibration ${inputs.suite.id} v${inputs.suite.version}, ${inputs.caseCount} case(s) x ${CALIBRATION_TREATMENTS.length} treatment(s) x 1 repetition, budget ${context.budgetMs} ms per model\n`,
	);

	for (const environment of inputs.environments) {
		await runSlotOf(environment, context);
	}

	if (!flags.has('dry-run')) {
		writeSelectionOf(inputs.suite, context);
	}
};
