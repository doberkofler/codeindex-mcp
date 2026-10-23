import {rngOf} from './bootstrapRng.ts';
import {type EconomicContractType} from './economicContract.ts';
import {hashOf} from './hash.ts';
import {type CaseType} from './schema.ts';
import {type PlanEntryType} from './suite.ts';

/** Economic effect that defines A/A label equivalence. */
export const AA_ECONOMIC_EFFECT = 0.1 as const;

/** Confidence used for the two-sided A/A equivalence interval. */
export const AA_CONFIDENCE = 0.95 as const;

/** Closed order of the two identical no-index arms. */
export const AA_ARM_LABELS = ['a', 'b'] as const;

export type AaArmLabelType = (typeof AA_ARM_LABELS)[number];

/** One predeclared A/A pair in the randomized plan. */
export type AaPairPlanType = Readonly<{
	caseId: string;
	pair: number;
	/** Label A uses odd repetition. */
	armARepetition: number;
	/** Label B uses even repetition. */
	armBRepetition: number;
	/** The label executed first in this pair. */
	first: AaArmLabelType;
}>;

/** Randomized A/A plan plus the exact label assignment. */
export type AaPlanType = Readonly<{
	plan: readonly PlanEntryType[];
	pairs: readonly AaPairPlanType[];
	seed: string;
	sourceDigest: string;
}>;

/**
 * Builds a deterministic randomized A/A plan.
 *
 * Both arms are the same `no-index` treatment. Each pair independently assigns
 * one of its two repetitions to label A and randomizes the execution order, so a
 * difference between labels cannot come from a fixed label or a fixed position.
 *
 * @param cases - Calibration cases in manifest order.
 * @param repetitionsPerCase - Number of A/B pairs per case.
 * @param seed - Predeclared randomization seed.
 * @returns The ordered plan and its label mapping.
 */
export const aaPlanOf = (cases: readonly CaseType[], repetitionsPerCase: number, seed: string): AaPlanType => {
	if (!Number.isInteger(repetitionsPerCase) || repetitionsPerCase < 1) {
		throw new Error('A/A repetitions per case must be a positive integer');
	}

	const random = rngOf(seed);
	const plan: PlanEntryType[] = [];
	const pairs: AaPairPlanType[] = [];

	for (const testCase of cases) {
		for (let pair = 1; pair <= repetitionsPerCase; pair += 1) {
			const odd = (pair - 1) * 2 + 1;
			const even = (pair - 1) * 2 + 2;
			const armARepetition = random() < 0.5 ? odd : even;
			const armBRepetition = armARepetition === odd ? even : odd;
			const first: AaArmLabelType = random() < 0.5 ? 'a' : 'b';
			const armA: PlanEntryType = {caseId: testCase.id, treatment: 'no-index', repetition: armARepetition};
			const armB: PlanEntryType = {caseId: testCase.id, treatment: 'no-index', repetition: armBRepetition};

			pairs.push({caseId: testCase.id, pair, armARepetition, armBRepetition, first});
			plan.push(...(first === 'a' ? [armA, armB] : [armB, armA]));
		}
	}

	return {
		plan,
		pairs,
		seed,
		sourceDigest: hashOf({cases: cases.map((testCase) => ({id: testCase.id, hash: hashOf(testCase)})), repetitionsPerCase, seed}),
	};
};

/**
 * Normalizes frozen contract weights to the selected calibration cases.
 *
 * @param contract - Frozen economic contract.
 * @param caseIds - Cases selected for A/A calibration.
 * @returns Weights that sum to one over the selected cases.
 */
export const aaWeightsOf = (contract: EconomicContractType, caseIds: readonly string[]): Readonly<Record<string, number>> => {
	const selected = Object.fromEntries(caseIds.map((caseId) => [caseId, contract.suite.caseWeights[caseId] ?? 0]));
	const total = Object.values(selected).reduce((sum, value) => sum + value, 0);
	const missing = caseIds.filter((caseId) => (selected[caseId] ?? 0) <= 0);

	if (missing.length > 0) {
		throw new Error(`A/A calibration case(s) have no positive frozen contract weight: ${missing.join(', ')}`);
	}

	return Object.fromEntries(caseIds.map((caseId) => [caseId, (selected[caseId] ?? 0) / total]));
};
