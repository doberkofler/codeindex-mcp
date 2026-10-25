import {rngOf} from './bootstrapRng.ts';
import {hashOf} from './hash.ts';
import {type ExposureCaseType} from './exposureDesign.ts';
import {type PlanEntryType} from './suite.ts';

/** One randomized direct/Code-Mode pair. */
export type ExposurePairType = Readonly<{
	caseId: string;
	pair: number;
	first: 'direct-mcp' | 'code-mode';
}>;

/** Randomized paired exposure plan plus its frozen seed. */
export type ExposurePlanType = Readonly<{
	plan: readonly PlanEntryType[];
	pairs: readonly ExposurePairType[];
	seed: string;
	sourceDigest: string;
}>;

/**
 * Builds the deterministic randomized exposure plan.
 *
 * Every repetition is one direct and one wrapped execution of the same case.
 * Pair order is randomized independently, so neither exposure is
 * systematically earlier in the campaign.
 *
 * @param cases - Frozen exposure cases in manifest order.
 * @param repetitions - Paired repetitions per case.
 * @param seed - Predeclared randomization seed.
 * @returns Ordered plan and its pair map.
 */
export const exposurePlanOf = (cases: readonly ExposureCaseType[], repetitions: number, seed: string): ExposurePlanType => {
	if (!Number.isInteger(repetitions) || repetitions < 1) {
		throw new Error('exposure repetitions must be a positive integer');
	}

	const random = rngOf(seed);
	const plan: PlanEntryType<'direct-mcp' | 'code-mode'>[] = [];
	const pairs: ExposurePairType[] = [];

	for (const testCase of cases) {
		for (let repetition = 1; repetition <= repetitions; repetition += 1) {
			const direct: PlanEntryType<'direct-mcp' | 'code-mode'> = {caseId: testCase.id, treatment: 'direct-mcp', repetition};
			const wrapped: PlanEntryType<'direct-mcp' | 'code-mode'> = {caseId: testCase.id, treatment: 'code-mode', repetition};
			const first = random() < 0.5 ? 'direct-mcp' : 'code-mode';

			pairs.push({caseId: testCase.id, pair: repetition, first});
			plan.push(...(first === 'direct-mcp' ? [direct, wrapped] : [wrapped, direct]));
		}
	}

	return {
		plan,
		pairs,
		seed,
		sourceDigest: hashOf({purpose: 'exposure-comparison-plan', cases: cases.map((testCase) => testCase.id), repetitions, seed}),
	};
};
