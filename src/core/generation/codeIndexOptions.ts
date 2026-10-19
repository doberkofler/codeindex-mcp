import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type ExtractorType} from '../../adapters/types.ts';
import {type ClockType} from '../freshness/refreshCoordinator.ts';

export type CodeIndexOptionsType = Readonly<{
	readonly workerEntry?: string;
	readonly clock?: ClockType;
	readonly watch?: boolean;
	readonly debounceMs?: number;
	readonly reconcileIntervalMs?: number;
	readonly analytics?: AnalyticsRecorderType;
	/** Adapter override for qualification; forces in-process builds. */
	readonly extractor?: ExtractorType;
}>;
