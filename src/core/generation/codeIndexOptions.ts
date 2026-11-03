import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type ExtractorType} from '../../adapters/types.ts';
import {type AdapterSetType, type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
import {type ClockType} from '../freshness/refreshCoordinator.ts';

export type CodeIndexOptionsType = Readonly<{
	readonly workerEntry?: string;
	readonly clock?: ClockType;
	readonly watch?: boolean;
	readonly debounceMs?: number;
	readonly reconcileIntervalMs?: number;
	readonly analytics?: AnalyticsRecorderType;
	/** Loaded adapters selected by the composition root. */
	readonly adapters?: readonly ExtractorType[];
	/** Worker descriptors matching `adapters`. */
	readonly adapterDescriptors?: readonly ResolvedAdapterDescriptorType[];
	/** Adapter override for qualification; forces in-process builds. */
	readonly extractor?: ExtractorType;
}>;

/**
 * Builds the loader-shaped adapter set injected into `CodeIndex`.
 *
 * @param options - Code index runtime options.
 * @returns Adapters, worker descriptors, and the id lookup.
 */
export const adapterSetOf = (options: CodeIndexOptionsType): AdapterSetType => {
	const adapters = options.adapters ?? [];

	return {
		adapters,
		descriptors: options.adapterDescriptors ?? [],
		byId: new Map(adapters.map((adapter) => [adapter.id, adapter])),
	};
};
