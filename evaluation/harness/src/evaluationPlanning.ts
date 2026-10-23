import {assertClaimEnvironmentOf, type CampaignClaimClassType} from './campaignClaim.ts';
import {type EnvironmentManifestType, assertEnvironmentModel} from './environment.ts';
import {type HostedReferenceType, assertHostedModel} from './hostedReference.ts';
import {type CaseType, type SuiteType} from './schema.ts';
import {planOf, selectCases, treatmentIdsOf, type PlanEntryType} from './suite.ts';
import {type TreatmentDefinitionType} from './treatment.ts';
import {allOf, flagOf, treatmentsOf} from './cliSupport.ts';

/** Consecutive model-free cold starts every hosted treatment must survive. */
export const COLD_START_RUNS = 20;

/** Resolved campaign selection before identity construction. */
export type CampaignSelectionType = Readonly<{
	selected: readonly CaseType[];
	treatments: readonly TreatmentDefinitionType[];
	repetitions: number;
	coldStarts: number;
	environment: EnvironmentManifestType | null;
	hostedReference: HostedReferenceType | null;
	plan: readonly PlanEntryType[];
}>;

type SelectionOptionsType = Readonly<{
	treatments?: readonly string[];
	repetitions?: number;
	coldStarts?: number;
	caseIds?: readonly string[];
	environment?: EnvironmentManifestType | null;
	hostedReference?: HostedReferenceType | null;
	claimClass?: CampaignClaimClassType;
	plan?: readonly PlanEntryType[];
}>;

const coldStartsOfOptions = (options: SelectionOptionsType): number => {
	// A hosted claim always runs the fixed twenty. Local diagnostics and the
	// deterministic CLI tests may lower the count explicitly; they never widen it.
	const declared = options.claimClass === 'hosted-model-scoped' ? COLD_START_RUNS : Number(process.env['EVAL_COLD_STARTS'] ?? COLD_START_RUNS);
	const coldStarts = options.coldStarts ?? declared;

	if (!Number.isInteger(coldStarts) || coldStarts < 1) {
		throw new Error('cold-start proof count must be a positive integer');
	}

	return coldStarts;
};

/**
 * Validates an explicitly supplied randomized plan.
 *
 * @param plan - Planned execution entries.
 * @param selected - Cases selected for the campaign.
 * @param treatments - Treatments selected for the campaign.
 */
const assertPlanOf = (plan: readonly PlanEntryType[], selected: readonly CaseType[], treatments: readonly TreatmentDefinitionType[]): void => {
	const caseIds = new Set<string>(selected.map((testCase) => testCase.id));
	const treatmentIds = new Set<string>(treatments.map((treatment) => treatment.id));
	const slots = new Set<string>();

	for (const entry of plan) {
		if (!caseIds.has(entry.caseId)) {
			throw new Error(`custom plan names unselected case ${entry.caseId}`);
		}

		if (!treatmentIds.has(entry.treatment)) {
			throw new Error(`custom plan names unselected treatment ${entry.treatment}`);
		}

		if (!Number.isInteger(entry.repetition) || entry.repetition <= 0) {
			throw new Error('custom plan repetitions must be positive integers');
		}

		const slot = `${entry.caseId}/${entry.treatment}/${entry.repetition}`;

		if (slots.has(slot)) {
			throw new Error(`custom plan contains duplicate slot ${slot}`);
		}

		slots.add(slot);
	}

	if (plan.length === 0) {
		throw new Error('custom plan selects no executions');
	}
};

/**
 * Resolves cases, treatments, repetitions, cold starts, pins, and the plan.
 *
 * @param flags - Parsed CLI flags.
 * @param options - Explicit options that cannot be widened by flags.
 * @param suite - Loaded suite, optionally rebound to another model.
 * @param cases - Loaded cases in manifest order.
 * @returns The resolved campaign selection.
 */
export const campaignSelectionOf = (
	flags: Map<string, string[]>,
	options: SelectionOptionsType,
	suite: SuiteType,
	cases: readonly CaseType[],
): CampaignSelectionType => {
	const selected = selectCases(cases, {caseIds: options.caseIds ?? allOf(flags, 'case'), tags: allOf(flags, 'tag')});
	const treatments =
		options.treatments === undefined
			? treatmentsOf(flagOf(flags, 'treatment'), suite.treatments)
			: treatmentsOf(options.treatments.join(','), suite.treatments);
	const repetitions = options.repetitions ?? Number(flagOf(flags, 'repetitions') ?? suite.repetitions);
	const environment = options.environment ?? null;
	const hostedReference = options.hostedReference ?? null;

	if (environment !== null) {
		assertEnvironmentModel(environment, suite.model);
	}

	if (hostedReference !== null) {
		assertHostedModel(hostedReference, suite.model);
	}

	assertClaimEnvironmentOf(options.claimClass, environment, hostedReference);
	const plan = options.plan ?? planOf(selected, treatmentIdsOf(treatments), repetitions);

	assertPlanOf(plan, selected, treatments);

	return {selected, treatments, repetitions, coldStarts: coldStartsOfOptions(options), environment, hostedReference, plan};
};
