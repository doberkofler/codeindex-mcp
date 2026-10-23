import {rngOf} from './bootstrapRng.ts';
import {isFiniteNonNegative} from './costStudy.ts';
import {EVALUATION_CONTRACT} from './economicContract.ts';

/** One paired pilot observation used only to size the later final campaign. */
export type PilotPairedObservationType = Readonly<{
	caseId: string;
	noIndexCostUsd: number;
	candidateCostUsd: number;
}>;

/** Result of the disjoint-pilot power simulation. */
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

/**
 * Sizes final repetitions by simulation from a disjoint paired pilot.
 *
 * The pilot supplies the paired per-case log-ratio effect and the within-case
 * variance. Between-case variance is retained descriptively. The final sample is
 * the smallest repetition count whose simulated probability of clearing both the
 * point target and the one-sided upper bound reaches the frozen power.
 *
 * @param pilot - Pilot campaign identity, paired observations, and simulation settings.
 * @param finalCampaignId - Final campaign identity, which must be disjoint.
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
	const random = rngOf(pilot.seed);
	const targetLogRatio = Math.log(EVALUATION_CONTRACT.cost.targetRatio);
	let selected: number | null = null;
	let selectedPower = 0;

	for (let repetitions = pilot.minRepetitions; repetitions <= pilot.maxRepetitions; repetitions += 1) {
		let successes = 0;

		for (let simulation = 0; simulation < pilot.simulations; simulation += 1) {
			const simulatedMeans = caseMeans.map((mean) => mean + normalDrawOf(random) * Math.sqrt(withinCaseVariance / repetitions));
			const simulatedEffect = simulatedMeans.reduce((total, value) => total + value, 0) / simulatedMeans.length;
			const standardError = Math.sqrt((betweenCaseVariance + withinCaseVariance / repetitions) / Math.max(1, simulatedMeans.length));
			const upper = simulatedEffect + Z_ONE_SIDED_95 * standardError;

			if (simulatedEffect <= targetLogRatio && upper < 0) {
				successes += 1;
			}
		}

		const power = successes / pilot.simulations;
		selected = repetitions;
		selectedPower = power;

		if (power >= pilot.desiredPower) {
			return {
				method: 'paired-log-ratio-simulation',
				pilotCampaignIds: pilot.campaignIds,
				finalCampaignId: pilot.finalCampaignId,
				pilotCaseCount: caseIds.length,
				pilotRepetitions: Math.max(...caseIds.map((caseId) => (byCase.get(caseId) ?? []).length)),
				betweenCaseVariance,
				withinCaseVariance,
				effectLogRatio,
				desiredPower: pilot.desiredPower,
				oneSidedAlpha: pilot.oneSidedAlpha,
				simulations: pilot.simulations,
				repetitions,
				power,
				reason: null,
			};
		}
	}

	return {
		method: 'paired-log-ratio-simulation',
		pilotCampaignIds: pilot.campaignIds,
		finalCampaignId: pilot.finalCampaignId,
		pilotCaseCount: caseIds.length,
		pilotRepetitions: Math.max(...caseIds.map((caseId) => (byCase.get(caseId) ?? []).length)),
		betweenCaseVariance,
		withinCaseVariance,
		effectLogRatio,
		desiredPower: pilot.desiredPower,
		oneSidedAlpha: pilot.oneSidedAlpha,
		simulations: pilot.simulations,
		repetitions: selected,
		power: selectedPower,
		reason: `power ${selectedPower.toFixed(3)} did not reach ${pilot.desiredPower.toFixed(2)} within ${pilot.maxRepetitions} repetitions`,
	};
};
