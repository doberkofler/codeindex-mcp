export type BuildProgressType = Readonly<{
	readonly phase: 'scanning' | 'building' | 'publishing';
	readonly adapterId: string | null;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

export const buildProgressFromWorker = (value: unknown): BuildProgressType | null => {
	if (!isRecord(value)) {
		return null;
	}

	const {phase, adapterId} = value;

	if (phase !== 'scanning' && phase !== 'building' && phase !== 'publishing') {
		return null;
	}

	if (adapterId !== null && typeof adapterId !== 'string') {
		return null;
	}

	return {phase, adapterId};
};
