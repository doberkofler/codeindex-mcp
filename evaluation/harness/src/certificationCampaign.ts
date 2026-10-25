import {type CertificationBlockType, type CertificationDesignType} from './certificationDesign.ts';
import {certificationPlanOf, type CertificationPlanType} from './certificationPlan.ts';
import {type CertificationBlockInputType} from './certificationBlock.ts';
import {type CertificationGateType, type CertificationRouteEvidenceType} from './certificationReport.ts';
import {evaluateCommand, type EvaluationOptionsType, type EvaluationRunType} from './cliEvaluate.ts';
import {type ExecutionProviderMeterType} from './executionMeter.ts';
import {type HostedReferenceType} from './hostedReference.ts';
import {manifestGateOf, runRouteGateOf} from './certificationGates.ts';
import {hashOf} from './hash.ts';

/** Deterministic cold starts required before the first hosted certification call. */
export const CERTIFICATION_COLD_STARTS = 20;

/** One loaded certification block. */
export type CertificationExecutableBlockType = Readonly<{
	block: CertificationBlockType;
}>;

/** Complete output of one certification execution attempt. */
export type CertificationCampaignResultType = Readonly<{
	route: CertificationRouteEvidenceType | null;
	blocks: readonly CertificationBlockInputType[];
	gates: readonly CertificationGateType[];
	failure: string | null;
	spentUsd: number;
}>;

/**
 * Returns the campaign failure when the model-free route gate did not pass.
 *
 * @param route - Route evidence, or null when the gate could not run.
 * @returns A closed failure reason, or null when the gate passed.
 */
export const routeGateFailureOf = (route: CertificationRouteEvidenceType | null): string | null => {
	if (route === null) {
		return 'model-free route gate produced no evidence';
	}

	return route.passed ? null : 'model-free route gate did not pass';
};

const blockFlagsOf = (flags: Map<string, string[]>, block: CertificationBlockType): Map<string, string[]> => {
	const clean = new Map<string, string[]>([['suite', [block.suite.path]]]);
	const campaignStore = flags.get('campaign-store')?.[0];

	if (campaignStore !== undefined) {
		clean.set('campaign-store', [campaignStore]);
	}

	if (flags.has('resume')) {
		clean.set('resume', ['true']);
	}

	return clean;
};

const optionsOf = (
	input: Readonly<{
		design: CertificationDesignType;
		hosted: HostedReferenceType;
		block: CertificationBlockType;
		plan: CertificationPlanType['plan'];
		providerMeter: ExecutionProviderMeterType;
		budgetMs: number;
	}>,
): EvaluationOptionsType => ({
	treatments: ['no-index', 'candidate'],
	repetitions: input.block.repetitions,
	caseIds: input.block.cases.map((testCase) => testCase.id),
	hostedReference: input.hosted,
	requireFrozen: true,
	model: input.design.model.reference,
	claimClass: 'hosted-model-scoped',
	comparison: false,
	coldStarts: CERTIFICATION_COLD_STARTS,
	budgetMs: input.budgetMs,
	providerMeter: input.providerMeter,
	plan: input.plan,
});

const costOfRun = (run: EvaluationRunType): number =>
	run.results.reduce((total, result) => total + (result.providerCost?.state === 'exact' ? (result.providerCost.totalUsd ?? 0) : 0), 0);

type BlocksRunType = Readonly<{
	blocks: readonly CertificationBlockInputType[];
	gates: readonly CertificationGateType[];
	failure: string | null;
	spentUsd: number;
}>;

const runBlocksOf = async (
	input: Readonly<{
		flags: Map<string, string[]>;
		design: CertificationDesignType;
		hosted: HostedReferenceType;
		blocks: readonly CertificationExecutableBlockType[];
		providerMeter: ExecutionProviderMeterType;
		startedMs: number;
	}>,
): Promise<BlocksRunType> => {
	const results: CertificationBlockInputType[] = [];
	const gates: CertificationGateType[] = [];
	let failure: string | null = null;
	let spentUsd = 0;

	for (const {block} of input.blocks) {
		const remaining = input.design.budget.maxWallClockMs - (Date.now() - input.startedMs);

		if (remaining <= 0) {
			failure = `wall-clock budget of ${input.design.budget.maxWallClockMs} ms was exhausted before ${block.id}`;
			break;
		}

		if (spentUsd > input.design.budget.maxProviderCostUsd) {
			failure = `provider cost budget of ${input.design.budget.maxProviderCostUsd} USD was exhausted before ${block.id}`;
			break;
		}

		const plan = certificationPlanOf(block, input.design.digest);

		process.stderr.write(`certification ${block.id} ${block.suite.id} ${plan.plan.length} execution(s)\n`);

		try {
			const run = await evaluateCommand(
				blockFlagsOf(input.flags, block),
				optionsOf({
					design: input.design,
					hosted: input.hosted,
					block,
					plan: plan.plan,
					providerMeter: input.providerMeter,
					budgetMs: remaining,
				}),
			);

			if (run === null) {
				throw new Error(`${block.id} execution returned no result`);
			}

			results.push({block, plan, runs: run.results});
			gates.push(manifestGateOf(input.design, block, run, hashOf(plan.plan)));
			spentUsd += costOfRun(run);

			if (run.budget?.exceeded === true) {
				failure = `wall-clock budget of ${input.design.budget.maxWallClockMs} ms was exceeded during ${block.id}`;
				break;
			}
		} catch (error) {
			failure = `${block.id} execution failed: ${error instanceof Error ? error.message : String(error)}`;
			break;
		}
	}

	if (spentUsd > input.design.budget.maxProviderCostUsd) {
		failure = `provider cost ${spentUsd} USD exceeds the frozen budget of ${input.design.budget.maxProviderCostUsd} USD`;
	}

	if (failure !== null) {
		gates.push({id: 'campaign-completeness', passed: false, detail: failure});
	}

	return {blocks: results, gates, failure, spentUsd};
};

/**
 * Re-runs the model-free route gate and executes every frozen certification
 * block in randomized paired order.
 *
 * @param input - Frozen design, hosted reference, blocks, flags, and meter.
 * @returns Route evidence, executed blocks, execution gates, and failure state.
 */
export const runCertificationCampaignOf = async (
	input: Readonly<{
		flags: Map<string, string[]>;
		design: CertificationDesignType;
		hosted: HostedReferenceType;
		blocks: readonly CertificationExecutableBlockType[];
		providerMeter: ExecutionProviderMeterType;
	}>,
): Promise<CertificationCampaignResultType> => {
	const startedMs = Date.now();
	const [primary] = input.blocks;
	let route: CertificationRouteEvidenceType | null = null;
	let failure: string | null = null;

	if (primary !== undefined) {
		try {
			route = await runRouteGateOf(input.design, primary.block);
		} catch (error) {
			failure = `model-free route gate failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	} else {
		failure = 'certification design has no primary block';
	}

	failure ??= routeGateFailureOf(route);

	if (failure !== null) {
		return {route, blocks: [], gates: [{id: 'campaign-completeness', passed: false, detail: failure}], failure, spentUsd: 0};
	}

	const executed = await runBlocksOf({...input, startedMs});

	return {route, ...executed};
};
