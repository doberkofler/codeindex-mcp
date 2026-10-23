import {rngOf} from './bootstrapRng.ts';
import {hashOf} from './hash.ts';
import {type CertificationBlockType} from './certificationDesign.ts';
import {type PlanEntryType} from './suite.ts';

/** One randomized no-index/candidate pair inside a certification block. */
export type CertificationPairType = Readonly<{
	caseId: string;
	pair: number;
	first: 'no-index' | 'candidate';
}>;

/** Randomized paired plan for one certification block. */
export type CertificationPlanType = Readonly<{
	blockId: CertificationBlockType['id'];
	plan: readonly PlanEntryType[];
	pairs: readonly CertificationPairType[];
	seed: string;
	sourceDigest: string;
}>;

/**
 * Builds the deterministic randomized plan for one certification block.
 *
 * Each repetition is one no-index and one candidate execution. Within a pair,
 * the order is randomized independently, so neither arm is systematically
 * earlier in the campaign. The seed is derived from the frozen design digest
 * and the block id, so a plan cannot be regenerated from a changed design.
 *
 * @param block - Frozen block with cases and repetitions.
 * @param designDigest - Digest of the complete frozen design.
 * @returns Ordered plan and its pair map.
 */
export const certificationPlanOf = (block: CertificationBlockType, designDigest: string): CertificationPlanType => {
	const seed = hashOf({purpose: 'certification-plan', design: designDigest, block: block.id});
	const random = rngOf(seed);
	const plan: PlanEntryType[] = [];
	const pairs: CertificationPairType[] = [];

	for (const testCase of block.cases) {
		for (let repetition = 1; repetition <= block.repetitions; repetition += 1) {
			const baseline: PlanEntryType = {caseId: testCase.id, treatment: 'no-index', repetition};
			const candidate: PlanEntryType = {caseId: testCase.id, treatment: 'candidate', repetition};
			const first = random() < 0.5 ? 'no-index' : 'candidate';

			pairs.push({caseId: testCase.id, pair: repetition, first});
			plan.push(...(first === 'no-index' ? [baseline, candidate] : [candidate, baseline]));
		}
	}

	const expected = block.cases.length * block.repetitions * 2;

	if (plan.length !== expected) {
		throw new Error(`certification plan produced ${plan.length} executions, expected ${expected}`);
	}

	return {
		blockId: block.id,
		plan,
		pairs,
		seed,
		sourceDigest: hashOf({
			purpose: 'certification-plan-source',
			design: designDigest,
			block: block.id,
			cases: block.cases.map((testCase) => ({id: testCase.id, weight: testCase.weight})),
			repetitions: block.repetitions,
		}),
	};
};
