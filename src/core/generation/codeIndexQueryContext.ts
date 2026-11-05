import {type ExactNamePresenceType, type QueryFreshnessType} from '../model.ts';
import {type QueryContextType} from '../query/queryService.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {type AdapterTargetType} from './adapterBuild.ts';

/**
 * Builds the shared query scope for one index generation.
 *
 * @param input - Database, generation, freshness, adapters, and telemetry hook.
 * @returns Query context with adapter-provided name normalizers.
 */
export const buildQueryContext = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		freshness: QueryFreshnessType;
		targets: readonly AdapterTargetType[];
		exactNameTelemetry?: ((presence: ExactNamePresenceType) => void) | undefined;
	}>,
): QueryContextType => {
	const normalizers = new Map<string, (text: string) => string>();

	for (const target of input.targets) {
		const normalize = target.extractor.normalizeQueryName;

		if (normalize !== undefined) {
			normalizers.set(target.adapter.id, normalize);
		}
	}

	return {
		database: input.database,
		generationId: input.generationId,
		freshness: input.freshness,
		adapters: input.targets.map((target) => target.adapter.id),
		normalizers,
		...(input.exactNameTelemetry === undefined ? {} : {exactNameTelemetry: input.exactNameTelemetry}),
	};
};
