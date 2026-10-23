import {type EconomicContractType} from './economicContract.ts';
import {type CorrectnessStudyType} from './economicAnalysis.ts';
import {type fixedSuiteCostStudyOf} from './costStudy.ts';
import {type AA_CONFIDENCE, type AA_ECONOMIC_EFFECT, type AaArmLabelType, type AaPlanType} from './aaPlan.ts';
import {type RunResultType} from './runTypes.ts';
import {type SampleSizeSimulationType} from './sampleSizeSimulation.ts';
import {type CaseType} from './schema.ts';

/** One A/A pair with its two stored results. */
export type AaPairType = Readonly<{
	caseId: string;
	pair: number;
	first: AaArmLabelType;
	armA: RunResultType;
	armB: RunResultType;
}>;

/** A closed invalidation cause for one planned A/A slot. */
export type AaFailureType = Readonly<{
	caseId: string;
	pair: number;
	arm: AaArmLabelType | 'pair';
	cause: string;
	detail: string;
}>;

/** Label equivalence decision tied to the frozen economic effect. */
export type AaEquivalenceType = Readonly<{
	method: 'predeclared-point-ratio-equivalence';
	confidence: typeof AA_CONFIDENCE;
	economicEffect: typeof AA_ECONOMIC_EFFECT;
	lowerBound: number;
	upperBound: number;
	pointRatio: ReturnType<typeof fixedSuiteCostStudyOf>['ratio'];
	interval95: Readonly<{low: number; high: number}> | null;
	intervalWithin: boolean;
	passed: boolean;
	reason: string | null;
}>;

/** Per-arm title and cache diagnostics from the sanitized cost vectors. */
export type AaArmDiagnosticsType = Readonly<{
	arm: AaArmLabelType;
	executions: number;
	meteredExecutions: number;
	totalCostUsd: number | null;
	agentOnlyCostUsd: number | null;
	titleRequests: number;
	titleCostUsd: number | null;
	titleCostShare: number | null;
	agentRequests: number;
	compactionRequests: number;
	cacheReadTokens: number | null;
	nonCachedInputTokens: number | null;
	cacheWriteTokens: number | null;
	cacheHitRate: number | null;
}>;

/** Observed variance and case-clustering facts. */
export type AaVarianceType = Readonly<{
	withinCaseVariance: number | null;
	betweenCaseVariance: number | null;
	/** Method-of-moments estimate after removing within-case sampling noise. */
	betweenCaseVarianceCorrected: number | null;
	effectLogRatio: number | null;
	intraclassCorrelation: number | null;
	designEffect: number | null;
	observations: number;
	replications: number;
}>;

/** Complete sanitized A/A calibration result. */
export type AaCalibrationType = Readonly<{
	recordType: 'aa-calibration';
	schemaVersion: 1;
	claimClass: 'validity-only';
	efficacyClaim: false;
	releaseAuthority: false;
	seed: string;
	caseIds: readonly string[];
	repetitionsPerCase: number;
	plannedSlots: number;
	storedSlots: number;
	pairCount: number;
	validPairs: number;
	failures: readonly AaFailureType[];
	variance: Omit<AaVarianceType, 'replications'>;
	labelEffect: Readonly<{
		equivalence: AaEquivalenceType;
		cost: ReturnType<typeof fixedSuiteCostStudyOf>;
		correctness: CorrectnessStudyType;
		correctnessDifference: number | null;
	}>;
	diagnostics: Readonly<{a: AaArmDiagnosticsType; b: AaArmDiagnosticsType}>;
	failureRate: Readonly<{
		planned: number;
		stored: number;
		valid: number;
		invalid: number;
		missing: number;
		byCause: Readonly<Record<string, number>>;
		attempts: number;
		retriedExecutions: number;
		invalidAttemptsByCause: Readonly<Record<string, number>>;
	}>;
	treatmentLabelInvariance: Readonly<{
		definitionHashes: readonly string[];
		surfaceDigests: readonly string[];
		identical: boolean;
	}>;
	sampleSize: Readonly<{
		/** Predeclared design alternative used for power, below the frozen target. */
		designEffectRatio: number;
		assumedEffectLogRatio: number;
		finalCaseCount: number;
		contractMaxRepetitions: number;
		simulationMaxRepetitions: number;
		cost: SampleSizeSimulationType;
		correctness: Readonly<{margin: number; standardDeviation: number | null; pairsRequired: number | null; repetitions: number | null; reason: string | null}>;
		chosenRepetitions: number | null;
		executions: number | null;
		withinFrozenExecutionBudget: boolean | null;
		clustering: Readonly<{cases: number; repetitionsPerCase: number; intraclassCorrelation: number | null; designEffect: number | null}>;
		reason: string | null;
	}>;
	passed: boolean;
}>;

/** Input for one A/A calibration analysis. */
export type AaCalibrationInputType = Readonly<{
	runs: readonly RunResultType[];
	cases: readonly CaseType[];
	repetitionsPerCase: number;
	seed: string;
	contract?: EconomicContractType;
	plan?: AaPlanType;
}>;
