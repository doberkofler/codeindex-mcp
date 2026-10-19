import {type BenchmarkProfileType} from './benchTypes.ts';
import {benchmarkCorpusCounts} from './corpus.ts';

export type ProgressStepType = Readonly<{
	id: string;
	kind: 'generated' | 'public' | 'reference';
}>;

export type StepHistoryType = ReadonlyMap<string, readonly number[]>;

const RUN_DURATION_FACTOR = 10;
const isProfile = (value: string): value is BenchmarkProfileType => value === 'small' || value === 'medium' || value === 'large' || value === 'xl';

const average = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const partsOf = (step: ProgressStepType): readonly string[] => step.id.split(':');

// Returns the history key that groups repeated runs of the same step.
const historyKeyOf = (step: ProgressStepType): string => {
	const parts = partsOf(step);
	return step.kind === 'reference' ? step.id : parts.slice(0, -1).join(':');
};

const profileOf = (step: ProgressStepType): BenchmarkProfileType | null => {
	const [, value] = partsOf(step);
	return step.kind === 'generated' && value !== undefined && isProfile(value) ? value : null;
};

const scenarioOf = (step: ProgressStepType): string | null => {
	const value = partsOf(step).at(2);
	return step.kind === 'generated' ? (value ?? null) : null;
};

// Formats a duration for terminal progress output.
export const formatDuration = (durationMs: number): string => {
	const seconds = Math.max(0, Math.round(durationMs / 1000));

	if (seconds < 60) {
		return `${String(seconds)}s`;
	}

	return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, '0')}s`;
};

// Estimates one step from completed durations. Generated profiles scale linearly
// by corpus file count, so a completed large run estimates a first xl run.
export const estimateStep = (step: ProgressStepType, history: StepHistoryType): number | null => {
	const exact = average(history.get(historyKeyOf(step)) ?? []);

	if (exact !== null) {
		return exact;
	}

	if (step.kind !== 'generated') {
		return null;
	}

	const profile = profileOf(step);
	const scenario = scenarioOf(step);

	if (profile === null || scenario === null) {
		return null;
	}

	if (scenario === 'run') {
		const cold = average(history.get(`generated:${profile}:cold`) ?? []);

		if (cold !== null) {
			return cold * RUN_DURATION_FACTOR;
		}
	}

	const currentCount = benchmarkCorpusCounts(profile).fileCount;
	const estimates: number[] = [];

	for (const [key, durations] of history) {
		const [otherKind, otherProfile, otherScenario] = key.split(':');

		if (otherKind !== 'generated' || otherScenario !== scenario || otherProfile === undefined || !isProfile(otherProfile)) {
			continue;
		}

		const duration = average(durations);

		if (duration !== null) {
			estimates.push((duration * currentCount) / benchmarkCorpusCounts(otherProfile).fileCount);
		}
	}

	return average(estimates);
};

// Sums the estimates for steps that have not started yet.
export const remainingEstimate = (steps: readonly ProgressStepType[], history: StepHistoryType): number | null => {
	const estimates = steps.map((step) => estimateStep(step, history)).filter((estimate): estimate is number => estimate !== null);
	return estimates.length === 0 ? null : estimates.reduce((sum, estimate) => sum + estimate, 0);
};

// Records one completed step duration for later estimates.
export const recordStepDuration = (history: Map<string, number[]>, step: ProgressStepType, durationMs: number): void => {
	const key = historyKeyOf(step);
	const durations = history.get(key) ?? [];
	durations.push(durationMs);
	history.set(key, durations);
};
