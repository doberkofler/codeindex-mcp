import {adapterConfigFor, type ConfigType} from '../config/config.ts';
import {extractorSourceExtensions} from '../../adapters/types.ts';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type GenerationRowType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {probeAdapter, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {recordCompilerDrift} from './compilerDriftTelemetry.ts';

/**
 * Unions the source extensions every configured adapter publishes.
 *
 * @param config - Resolved configuration.
 * @param targets - Configured adapters and implementations.
 * @returns Deduplicated extension list.
 */
export const adapterSourceExtensions = (config: ConfigType, targets: readonly AdapterTargetType[]): readonly string[] => [
	...new Set(targets.flatMap((target) => extractorSourceExtensions(target.extractor, adapterConfigFor(config, target.adapter)))),
];

/**
 * Intersects ignored directory segments across adapters.
 *
 * A directory is ignored only when every adapter ignores it; otherwise one
 * adapter would lose events another adapter needs.
 *
 * @param targets - Configured adapters.
 * @returns Segments every adapter ignores.
 */
export const adapterIgnoredSegments = (targets: readonly AdapterTargetType[]): readonly string[] => {
	const [first, ...rest] = targets;

	if (first === undefined) {
		return [];
	}

	return first.extractor.ignoredSegments.filter((segment) => rest.every((target) => target.extractor.ignoredSegments.includes(segment)));
};

/**
 * Unions every adapter configuration file and watch input.
 *
 * @param config - Resolved configuration.
 * @param targets - Configured adapters.
 * @returns Deduplicated absolute paths.
 */
export const adapterConfigFiles = (config: ConfigType, targets: readonly AdapterTargetType[]): readonly string[] => [
	...new Set(targets.flatMap((target) => target.extractor.configFiles(adapterConfigFor(config, target.adapter)))),
];

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
	}>,
): Promise<readonly AdapterScanPlanType[]> => {
	const plans: AdapterScanPlanType[] = [];

	for (const target of input.targets) {
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
		const scan = await target.extractor.scan(scoped, knownPaths);

		if (scan.compilerDrift) {
			recordCompilerDrift({logger: input.logger, analytics: input.analytics, observed: input.observed, scan});
		}

		plans.push({adapterId: target.adapter.id, coverage: 'present', absenceReason: null, scan});
	}

	return plans;
};
