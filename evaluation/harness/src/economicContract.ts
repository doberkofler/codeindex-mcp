import {hashOf} from './hash.ts';

/** Version of the frozen economic and statistical contract. */
export const ECONOMIC_CONTRACT_VERSION = 2 as const;

/** Stable identifier of the accepted validity-v2 contract. */
export const ECONOMIC_CONTRACT_ID = 'evaluation-validity-v2' as const;

/** One provider tariff band, denominated in USD per million tokens. */
export type TariffBandType = Readonly<{
	cacheReadInputPerMillionUsd: number;
	cacheMissInputPerMillionUsd: number;
	/** Every provider-named cache-write tier, with its own rate. */
	cacheWritePerMillionUsd: Readonly<Record<string, number>>;
	outputPerMillionUsd: number;
	reasoningPerMillionUsd: number;
}>;

/** Declared peak window in UTC. Weekdays use ISO numbering, Monday = 1. */
export type PeakWindowType = Readonly<{
	weekdays: readonly number[];
	startUtcHour: number;
	endUtcHour: number;
}>;

/**
 * Frozen official tariff snapshot.
 *
 * The snapshot is the rate card, not an invoice. Provider discounts, credits,
 * holiday calendars published after the snapshot, and invoice-time adjustments
 * remain outside it.
 */
export type TariffSnapshotType = Readonly<{
	id: string;
	provider: string;
	modelId: string;
	modelVersion: string;
	currency: 'USD';
	unit: 'per-million-tokens';
	source: string;
	retrievedAt: string;
	effectiveFrom: string;
	bands: Readonly<{peak: TariffBandType; offPeak: TariffBandType}>;
	peakWindows: readonly PeakWindowType[];
	/** UTC dates that are off-peak despite matching a peak window. */
	holidayExclusions: readonly string[];
}>;

/** One complete frozen evaluation contract. */
export type EconomicContractType = Readonly<{
	id: typeof ECONOMIC_CONTRACT_ID;
	version: typeof ECONOMIC_CONTRACT_VERSION;
	frozenAt: string;
	metricName: string;
	suite: Readonly<{
		id: string;
		version: number;
		caseCount: number;
		weighting: 'class-balanced';
		classWeights: Readonly<Record<string, number>>;
		caseWeights: Readonly<Record<string, number>>;
	}>;
	model: Readonly<{
		provider: string;
		modelId: string;
		modelVersion: string;
		reference: string;
		runtime: string;
		exposureMode: 'native-mcp';
		codeMode: 'absent';
	}>;
	estimand: Readonly<{
		population: 'fixed-suite';
		metric: 'total-user-visible-task-cost-usd';
		form: 'ratio-of-preweighted-means';
		arms: readonly ['candidate', 'no-index'];
		includesIncorrectValidExecutions: true;
	}>;
	cost: Readonly<{
		targetRatio: number;
		confidence: 0.95;
		sided: 'one-sided';
		upperBoundBelow: number;
	}>;
	correctness: Readonly<{
		metric: 'paired-success-rate-difference';
		nonInferiorityMargin: number;
		confidence: 0.95;
		sided: 'one-sided';
		falseAbsenceTolerance: 0;
	}>;
	latency: Readonly<{
		metric: 'wall-time-ms';
		timeoutCeilingMs: number;
		optimizationTarget: false;
	}>;
	output: Readonly<{
		metric: 'all-tool-output-bytes';
		families: readonly string[];
		narrowerLegacyMetric: 'retrievalBytes';
	}>;
	confidence: Readonly<{
		method: 'paired-case-cluster-percentile-bootstrap';
		resamples: number;
		oneSidedUpperQuantile: number;
		twoSidedLowerQuantile: number;
		twoSidedUpperQuantile: number;
	}>;
	caseGeneralization: Readonly<{
		method: 'paired-case-uniform-bootstrap';
		population: 'case-superpopulation';
		authority: 'descriptive';
	}>;
	sampleSize: Readonly<{
		method: 'paired-log-ratio-simulation';
		desiredPower: number;
		oneSidedAlpha: number;
		simulations: number;
		minRepetitions: number;
		maxRepetitions: number;
		requiresDisjointPilotCampaign: true;
	}>;
	budget: Readonly<{
		caseCount: number;
		treatments: number;
		repetitions: number;
		executions: number;
		maxWallClockMs: number;
		maxProviderCostUsd: number;
	}>;
	tariff: TariffSnapshotType;
}>;

/** The accepted DeepSeek tariff retained with the contract. */
export const TARIFF_SNAPSHOT: TariffSnapshotType = {
	id: 'deepseek-flash-2026-10-23',
	provider: 'deepseek',
	modelId: 'deepseek-flash',
	modelVersion: 'DeepSeek-V4.1-Flash-1017',
	currency: 'USD',
	unit: 'per-million-tokens',
	source: 'https://api-docs.deepseek.com/quick_start/pricing',
	retrievedAt: '2026-10-23T00:00:00.000Z',
	effectiveFrom: '2026-09-10T00:00:00.000Z',
	bands: {
		peak: {
			cacheReadInputPerMillionUsd: 0.006,
			cacheMissInputPerMillionUsd: 0.3,
			cacheWritePerMillionUsd: {},
			outputPerMillionUsd: 1.2,
			reasoningPerMillionUsd: 1.2,
		},
		offPeak: {
			cacheReadInputPerMillionUsd: 0.003,
			cacheMissInputPerMillionUsd: 0.15,
			cacheWritePerMillionUsd: {},
			outputPerMillionUsd: 0.6,
			reasoningPerMillionUsd: 0.6,
		},
	},
	peakWindows: [
		{weekdays: [1, 2, 3, 4, 5], startUtcHour: 1, endUtcHour: 4},
		{weekdays: [1, 2, 3, 4, 5], startUtcHour: 6, endUtcHour: 10},
	],
	holidayExclusions: [],
};

const CLASS_CASE_IDS = {
	locate: ['locate-schema-version', 'locate-read-symbol-tool', 'locate-stale-file-error', 'locate-result-size-guard'],
	impact: [
		'impact-build-generation-references',
		'impact-hash-content-references',
		'impact-bounded-paged-result-references',
		'impact-schema-version-references',
		'impact-config-load-references',
		'impact-codeindex-error-references',
	],
	semantic: [
		'semantic-renamed-reexport',
		'semantic-barrel-chain',
		'semantic-shadowed-name',
		'semantic-interface-implementations',
		'semantic-type-only-import',
		'semantic-default-export',
	],
	implementation: ['impl-default-result-bytes', 'impl-empty-relative-path'],
} as const;

const CLASS_WEIGHTS = {locate: 0.25, impact: 0.25, semantic: 0.25, implementation: 0.25} as const;

const CASE_WEIGHTS: Readonly<Record<string, number>> = Object.fromEntries(
	(['locate', 'impact', 'semantic', 'implementation'] as const).flatMap((caseClass) =>
		CLASS_CASE_IDS[caseClass].map((caseId) => [caseId, CLASS_WEIGHTS[caseClass] / CLASS_CASE_IDS[caseClass].length] as const),
	),
);

/** Accepted validity-v2 contract, frozen before any A/B treatment result is observed. */
export const EVALUATION_CONTRACT: EconomicContractType = {
	id: ECONOMIC_CONTRACT_ID,
	version: ECONOMIC_CONTRACT_VERSION,
	frozenAt: '2026-10-23T00:00:00.000Z',
	metricName: 'preweighted candidate/no-index total user-visible task cost',
	suite: {
		id: 'codeindex-release',
		version: 1,
		caseCount: 18,
		weighting: 'class-balanced',
		classWeights: CLASS_WEIGHTS,
		caseWeights: CASE_WEIGHTS,
	},
	model: {
		provider: 'deepseek',
		modelId: 'deepseek-flash',
		modelVersion: 'DeepSeek-V4.1-Flash-1017',
		reference: 'deepseek/deepseek-flash',
		runtime: 'opencode 2.1.2',
		exposureMode: 'native-mcp',
		codeMode: 'absent',
	},
	estimand: {
		population: 'fixed-suite',
		metric: 'total-user-visible-task-cost-usd',
		form: 'ratio-of-preweighted-means',
		arms: ['candidate', 'no-index'],
		includesIncorrectValidExecutions: true,
	},
	cost: {targetRatio: 0.9, confidence: 0.95, sided: 'one-sided', upperBoundBelow: 1},
	correctness: {
		metric: 'paired-success-rate-difference',
		nonInferiorityMargin: 0.02,
		confidence: 0.95,
		sided: 'one-sided',
		falseAbsenceTolerance: 0,
	},
	latency: {metric: 'wall-time-ms', timeoutCeilingMs: 180_000, optimizationTarget: false},
	output: {
		metric: 'all-tool-output-bytes',
		families: ['index', 'search', 'read', 'list', 'write', 'execute', 'task', 'other'],
		narrowerLegacyMetric: 'retrievalBytes',
	},
	confidence: {
		method: 'paired-case-cluster-percentile-bootstrap',
		resamples: 2000,
		oneSidedUpperQuantile: 0.95,
		twoSidedLowerQuantile: 0.025,
		twoSidedUpperQuantile: 0.975,
	},
	caseGeneralization: {method: 'paired-case-uniform-bootstrap', population: 'case-superpopulation', authority: 'descriptive'},
	sampleSize: {
		method: 'paired-log-ratio-simulation',
		desiredPower: 0.8,
		oneSidedAlpha: 0.05,
		simulations: 2000,
		minRepetitions: 1,
		maxRepetitions: 20,
		requiresDisjointPilotCampaign: true,
	},
	budget: {
		caseCount: 18,
		treatments: 3,
		repetitions: 5,
		executions: 270,
		maxWallClockMs: 48_600_000,
		maxProviderCostUsd: 25,
	},
	tariff: TARIFF_SNAPSHOT,
};

/** Pin that binds a campaign to one exact contract revision. */
export type ContractPinType = Readonly<{
	id: string;
	version: number;
	digest: string;
	frozenAt: string;
}>;

/** Contract plus the digest retained in a manifest. */
export type ContractRecordType = EconomicContractType & Readonly<{digest: string}>;

/**
 * Hashes the complete contract.
 *
 * Any tariff, weight, margin, target, model, exposure, budget, or confidence
 * change yields a different digest and therefore a different campaign identity.
 *
 * @param contract - Contract to hash.
 * @returns Lowercase hex SHA-256 digest.
 */
export const contractDigestOf = (contract: EconomicContractType): string => hashOf(contract);

/** Accepted contract digest. */
export const EVALUATION_CONTRACT_DIGEST = contractDigestOf(EVALUATION_CONTRACT);

/** Pin of the accepted contract. */
export const EVALUATION_CONTRACT_PIN: ContractPinType = {
	id: EVALUATION_CONTRACT.id,
	version: EVALUATION_CONTRACT.version,
	digest: EVALUATION_CONTRACT_DIGEST,
	frozenAt: EVALUATION_CONTRACT.frozenAt,
};

/**
 * Builds the identity pin for a contract.
 *
 * @param contract - Contract to pin.
 * @returns Its id, version, digest, and frozen timestamp.
 */
export const contractPinOf = (contract: EconomicContractType = EVALUATION_CONTRACT): ContractPinType => ({
	id: contract.id,
	version: contract.version,
	digest: contractDigestOf(contract),
	frozenAt: contract.frozenAt,
});

/**
 * Adds the contract digest to the frozen record written into a manifest.
 *
 * @param contract - Accepted contract.
 * @returns Contract record with its digest.
 */
export const contractRecordOf = (contract: EconomicContractType = EVALUATION_CONTRACT): ContractRecordType => ({
	...contract,
	digest: contractDigestOf(contract),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Verifies a stored contract record against the accepted frozen contract.
 *
 * @param value - Untrusted manifest contract field.
 * @returns The accepted contract pin.
 */
export const contractPinOfUnknown = (value: unknown): ContractPinType => {
	if (!isRecord(value)) {
		throw new Error('campaign contract must be an object');
	}

	const {digest, ...fields} = value;
	const {id, version, frozenAt} = fields;

	if (typeof digest !== 'string' || typeof id !== 'string' || typeof version !== 'number' || typeof frozenAt !== 'string') {
		throw new TypeError('campaign contract is missing its id, version, digest, or frozen timestamp');
	}

	if (hashOf(fields) !== digest) {
		throw new Error('campaign contract content does not match its digest; thresholds or weights were changed after the manifest was written');
	}

	if (digest !== EVALUATION_CONTRACT_DIGEST) {
		throw new Error('campaign contract is not the accepted validity-v2 contract');
	}

	return {id, version, digest, frozenAt};
};

/**
 * Rejects any campaign that is not bound to the accepted contract.
 *
 * @param pin - Contract pin read from a manifest or run identity.
 */
export const assertAcceptedContractOf = (pin: ContractPinType): void => {
	if (pin.digest !== EVALUATION_CONTRACT_DIGEST || pin.id !== EVALUATION_CONTRACT.id || pin.version !== EVALUATION_CONTRACT.version) {
		throw new Error('campaign is not bound to the accepted validity-v2 economic contract');
	}
};
