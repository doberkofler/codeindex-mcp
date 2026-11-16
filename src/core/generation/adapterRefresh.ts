import {type AdapterExecutionContextType} from '@codeindex/adapter-sdk';

import {adapterConfigFor, type ConfigType} from '../config/config.ts';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type GenerationRowType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {probeAdapter, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {recordCompilerDrift} from './compilerDriftTelemetry.ts';
import {type BuildProgressType} from './buildProgress.ts';

/**
 * Narrows configured adapters to the event scope.
 *
 * @param targets - Every configured adapter.
 * @param adapterIds - Adapters that changed, or null for every adapter.
 * @returns The scoped targets, or every target when the scope names none.
 */
export const adapterTargetsForScope = (targets: readonly AdapterTargetType[], adapterIds: readonly string[] | null): readonly AdapterTargetType[] => {
	if (adapterIds === null) {
		return targets;
	}

	const scoped = targets.filter((target) => adapterIds.includes(target.adapter.id));
	// An empty scope would mean an event named no configured adapter. Treat it
	// as unknown invalidation rather than pretending the index is current.
	return scoped.length === 0 ? targets : scoped;
};

/**
 * Probes and scans every configured adapter.
 *
 * @param input - Configuration, adapters, database, published generation, and telemetry sinks.
 * @returns One scan plan per adapter, including declared optional absence.
 */
export const planAdapterScans = async (
	input: Readonly<{
		config: ConfigType;
		targets: readonly AdapterTargetType[];
		database: IndexDatabase;
		published: GenerationRowType | null;
		logger: LoggerType;
		analytics: AnalyticsRecorderType | null;
		observed: Set<string>;
		executionContext?: AdapterExecutionContextType;
		onProgress?: (progress: BuildProgressType) => void;
	}>,
): Promise<readonly AdapterScanPlanType[]> => {
	const plans: AdapterScanPlanType[] = [];

	for (const target of input.targets) {
		input.onProgress?.({phase: 'scanning', adapterId: target.adapter.id});
		input.executionContext?.throwIfCancellationRequested();
		const scoped = adapterConfigFor(input.config, target.adapter);
		// Adapter probes are sequential so absence and failure attribution follow
		// configuration order.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const probe = await probeAdapter(target, scoped);

		if (probe.coverage === 'absent') {
			plans.push({adapterId: target.adapter.id, coverage: 'absent', absenceReason: probe.reason, scan: null});
			continue;
		}

		const knownPaths = input.published === null ? [] : input.database.listFiles(input.published.id, target.adapter.id).map((file) => file.path);
		// oxlint-disable-next-line eslint/no-await-in-loop
		const scan = await target.extractor.scan(scoped, knownPaths, input.executionContext);

		if (scan.compilerDrift) {
			recordCompilerDrift({logger: input.logger, analytics: input.analytics, observed: input.observed, scan});
		}

		plans.push({adapterId: target.adapter.id, coverage: 'present', absenceReason: null, scan});
	}

	return plans;
};
