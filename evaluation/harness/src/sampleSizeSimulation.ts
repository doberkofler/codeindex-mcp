import {rngOf} from './bootstrapRng.ts';
import {isFiniteNonNegative} from './costStudy.ts';
import {EVALUATION_CONTRACT} from './economicContract.ts';

/** One paired pilot observation used only to size the later final campaign. */
export type PilotPairedObservationType = Readonly<{
	caseId: string;
	noIndexCostUsd: number;
	candidateCostUsd: number;
}>;

/** Result of a paired power simulation from observed variance. */
export type SampleSizeSimulationType = Readonly<{
	method: 'paired-log-ratio-simulation';
	pilotCampaignIds: readonly string[];
	finalCampaignId: string;
	pilotCaseCount: number;
	pilotRepetitions: number;
	betweenCaseVariance: number;
	withinCaseVariance: number;
	effectLogRatio: number;
	desiredPower: number;
	oneSidedAlpha: number;
	simulations: number;
	repetitions: number | null;
	power: number;
	reason: string | null;
}>;

const sampleVarianceOf = (values: readonly number[]): number => {
	if (values.length < 2) {
		return 0;
	}

	const mean = values.reduce((total, value) => total + value, 0) / values.length;

	return values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
};

const normalDrawOf = (random: () => number): number => {
	const first = Math.max(random(), Number.EPSILON);
	const second = random();

	return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

const Z_ONE_SIDED_95 = 1.6448536269514722;

/** Variance facts retained beside a selected sample size. */
export type SampleSizeVarianceInputType = Readonly<{
	campaignIds: readonly string[];
	finalCampaignId: string;
	caseCount: number;
	pilotRepetitions: number;
	effectLogRatio: number;
	betweenCaseVariance: number;
	withinCaseVariance: number;
	desiredPower: number;
	oneSidedAlpha: number;
	simulations: number;
	minRepetitions: number;
	maxRepetitions: number;
	seed: string;
	/** When set, simulate this effect instead of the observed case-mean effect. */
	assumedEffectLogRatio?: number;
}>;

/**
 * Simulates final repetitions from observed paired variance.
 *
 * Between-case and within-case variances are retained separately so case
 * clustering remains visible. An assumed effect may be supplied when the pilot
 * is an A/A calibration: the calibration measures natural variance, while the
 * final sample must be sized for the frozen economic target rather than for the
 * observed near-null label difference.
 *
 * @param input - Variance facts, frozen simulation settings, and optional assumed effect.
 * @returns The smallest repetition count that reaches the frozen power.
 */
export const finalSampleSizeFromVarianceOf = (input: SampleSizeVarianceInputType): SampleSizeSimulationType => {
	if (input.campaignIds.includes(input.finalCampaignId)) {
		throw new Error('final sample size requires a pilot campaign disjoint from the final campaign');
	}

	if (input.caseCount <= 0) {
		throw new Error('sample-size simulation requires at least one case');
	}

	if (!isFiniteNonNegative(input.betweenCaseVariance) || !isFiniteNonNegative(input.withinCaseVariance)) {
		throw new Error('sample-size variances must be finite and non-negative');
	}

	const effect = input.assumedEffectLogRatio ?? input.effectLogRatio;
	const random = rngOf(input.seed);
	const targetLogRatio = Math.log(EVALUATION_CONTRACT.cost.targetRatio);
	let selected: number | null = null;
	let selectedPower = 0;

	for (let repetitions = input.minRepetitions; repetitions <= input.maxRepetitions; repetitions += 1) {
		let successes = 0;

		for (let simulation = 0; simulation < input.simulations; simulation += 1) {
			const simulatedMeans = Array.from({length: input.caseCount}, () => effect + normalDrawOf(random) * Math.sqrt(input.withinCaseVariance / repetitions));
			const simulatedEffect = simulatedMeans.reduce((total, value) => total + value, 0) / simulatedMeans.length;
			const standardError = Math.sqrt((input.betweenCaseVariance + input.withinCaseVariance / repetitions) / input.caseCount);
			const upper = simulatedEffect + Z_ONE_SIDED_95 * standardError;

			if (simulatedEffect <= targetLogRatio && upper < 0) {
				successes += 1;
			}
		}

		const power = successes / input.simulations;
		selected = repetitions;
		selectedPower = power;

		if (power >= input.desiredPower) {
			return {
				method: 'paired-log-ratio-simulation',
				pilotCampaignIds: input.campaignIds,
				finalCampaignId: input.finalCampaignId,
				pilotCaseCount: input.caseCount,
				pilotRepetitions: input.pilotRepetitions,
				betweenCaseVariance: input.betweenCaseVariance,
				withinCaseVariance: input.withinCaseVariance,
				effectLogRatio: input.effectLogRatio,
				desiredPower: input.desiredPower,
				oneSidedAlpha: input.oneSidedAlpha,
				simulations: input.simulations,
				repetitions,
				power,
				reason: null,
			};
		}
	}

	return {
		method: 'paired-log-ratio-simulation',
		pilotCampaignIds: input.campaignIds,
		finalCampaignId: input.finalCampaignId,
		pilotCaseCount: input.caseCount,
		pilotRepetitions: input.pilotRepetitions,
		betweenCaseVariance: input.betweenCaseVariance,
		withinCaseVariance: input.withinCaseVariance,
		effectLogRatio: input.effectLogRatio,
		desiredPower: input.desiredPower,
		oneSidedAlpha: input.oneSidedAlpha,
		simulations: input.simulations,
		repetitions: selected,
		power: selectedPower,
		reason: `power ${selectedPower.toFixed(3)} did not reach ${input.desiredPower.toFixed(2)} within ${input.maxRepetitions} repetitions`,
	};
};

/**
 * Sizes final repetitions by simulation from a disjoint paired pilot.
 *
 * @param pilot - Pilot campaign identity, paired observations, and simulation settings.
 * @returns The selected repetition count and its simulated power.
 */
export const finalSampleSizeOf = (
	pilot: Readonly<{
		campaignIds: readonly string[];
		observations: readonly PilotPairedObservationType[];
		finalCampaignId: string;
		desiredPower: number;
		oneSidedAlpha: number;
		simulations: number;
		minRepetitions: number;
		maxRepetitions: number;
		seed: string;
	}>,
): SampleSizeSimulationType => {
	if (pilot.campaignIds.includes(pilot.finalCampaignId)) {
		throw new Error('final sample size requires a pilot campaign disjoint from the final campaign');
	}

	const byCase = new Map<string, number[]>();

	for (const observation of pilot.observations) {
		if (!isFiniteNonNegative(observation.noIndexCostUsd) || !isFiniteNonNegative(observation.candidateCostUsd)) {
			throw new Error('pilot costs must be finite and non-negative');
		}

		if (observation.noIndexCostUsd === 0 || observation.candidateCostUsd === 0) {
			throw new Error('pilot sample-size simulation requires positive costs in both arms');
		}

		const values = byCase.get(observation.caseId) ?? [];
		values.push(Math.log(observation.candidateCostUsd / observation.noIndexCostUsd));
		byCase.set(observation.caseId, values);
	}

	const caseIds = [...byCase.keys()];
	const caseMeans = caseIds.map((caseId) => {
		const values = byCase.get(caseId) ?? [];
		return values.reduce((total, value) => total + value, 0) / values.length;
	});
	const withinVariances = caseIds.map((caseId) => sampleVarianceOf(byCase.get(caseId) ?? []));
	const withinCaseVariance = withinVariances.reduce((total, value) => total + value, 0) / Math.max(1, withinVariances.length);
	const betweenCaseVariance = sampleVarianceOf(caseMeans);
	const effectLogRatio = caseMeans.reduce((total, value) => total + value, 0) / Math.max(1, caseMeans.length);

	return finalSampleSizeFromVarianceOf({
		campaignIds: pilot.campaignIds,
		finalCampaignId: pilot.finalCampaignId,
		caseCount: caseIds.length,
		pilotRepetitions: Math.max(...caseIds.map((caseId) => (byCase.get(caseId) ?? []).length)),
		effectLogRatio,
		betweenCaseVariance,
		withinCaseVariance,
		desiredPower: pilot.desiredPower,
		oneSidedAlpha: pilot.oneSidedAlpha,
		simulations: pilot.simulations,
		minRepetitions: pilot.minRepetitions,
		maxRepetitions: pilot.maxRepetitions,
		seed: pilot.seed,
	});
};
