import {rngOf} from './bootstrapRng.ts';
import {hashOf} from './hash.ts';
import {type PilotCaseType} from './pilotDesign.ts';
import {type PlanEntryType} from './suite.ts';

/** One randomized no-index/candidate pair. */
export type PilotPairType = Readonly<{
	caseId: string;
	pair: number;
	first: 'no-index' | 'candidate';
}>;

/** Randomized paired development plan plus its frozen seed. */
export type PilotPlanType = Readonly<{
	plan: readonly PlanEntryType[];
	pairs: readonly PilotPairType[];
	seed: string;
	sourceDigest: string;
}>;

/**
 * Builds the deterministic randomized development plan.
 *
 * Every repetition is a pair of one no-index and one candidate execution. Pair
 * order is randomized independently, so no treatment is systematically earlier
 * in the campaign and provider rate limiting cannot masquerade as an effect.
 *
 * @param cases - Frozen pilot cases in manifest order.
 * @param repetitions - Paired repetitions per case.
 * @param seed - Predeclared randomization seed.
 * @returns Ordered plan and its pair map.
 */
export const pilotPlanOf = (cases: readonly PilotCaseType[], repetitions: number, seed: string): PilotPlanType => {
	if (!Number.isInteger(repetitions) || repetitions < 1) {
		throw new Error('pilot repetitions must be a positive integer');
	}

	const random = rngOf(seed);
	const plan: PlanEntryType[] = [];
	const pairs: PilotPairType[] = [];

	for (const testCase of cases) {
		for (let repetition = 1; repetition <= repetitions; repetition += 1) {
			const baseline: PlanEntryType = {caseId: testCase.id, treatment: 'no-index', repetition};
			const candidate: PlanEntryType = {caseId: testCase.id, treatment: 'candidate', repetition};
			const first = random() < 0.5 ? 'no-index' : 'candidate';

			pairs.push({caseId: testCase.id, pair: repetition, first});
			plan.push(...(first === 'no-index' ? [baseline, candidate] : [candidate, baseline]));
		}
	}

	return {
		plan,
		pairs,
		seed,
		sourceDigest: hashOf({purpose: 'development-pilot-plan', cases: cases.map((testCase) => ({id: testCase.id, weight: testCase.weight})), repetitions, seed}),
	};
};
