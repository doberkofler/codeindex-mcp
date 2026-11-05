import path from 'node:path';
import {adapterConfigFor, type ConfigType} from '../config/config.ts';
import {extractorSourceExtensions} from '../../adapters/types.ts';
import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type WatchRouteType} from '../freshness/workspaceWatcher.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type GenerationRowType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {probeAdapter, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {recordCompilerDrift} from './compilerDriftTelemetry.ts';

const {resolve} = path;

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
 * Projects the shared watcher configuration into logical adapter routes.
 *
 * The watcher keeps one physical subscription. Routes only decide which adapter
 * a changed path invalidates. Published file rows are authoritative after a
 * refresh; a scan plan supplies the same identities before the first
 * publication and contributes watch inputs that are not persisted.
 *
 * @param input - Configuration, targets, optional scan plans, published
 * generation, and remembered adapter watch inputs.
 * @returns One route per configured adapter.
 */
const adapterWatchRoutes = (
	input: Readonly<{
		config: ConfigType;
		targets: readonly AdapterTargetType[];
		plans?: readonly AdapterScanPlanType[];
		database?: IndexDatabase;
		published?: GenerationRowType | null;
		watchInputs?: ReadonlyMap<string, readonly string[]>;
	}>,
): readonly WatchRouteType[] =>
	input.targets.map((target) => {
		const adapterId = target.adapter.id;
		const scoped = adapterConfigFor(input.config, target.adapter);
		const plan = input.plans?.find((candidate) => candidate.adapterId === adapterId);
		const publishedFiles =
			plan?.scan?.files.map((file) => file.absolutePath) ??
			(input.database === undefined || input.published === undefined || input.published === null
				? []
				: input.database.listFiles(input.published.id, adapterId).map((file) => resolve(input.config.rootDir, file.path)));

		return {
			id: adapterId,
			sourceExtensions: extractorSourceExtensions(target.extractor, scoped),
			files: publishedFiles,
			configFiles: [...new Set([...target.extractor.configFiles(scoped), ...(plan?.scan?.watchInputs ?? input.watchInputs?.get(adapterId) ?? [])])],
		};
	});

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
 * Merges non-source watch inputs discovered by the latest scan.
 *
 * @param plans - Scan plans from this attempt.
 * @param previous - Inputs remembered from earlier attempts.
 * @returns A map covering scanned adapters plus untouched ones.
 */
export const adapterWatchInputs = (
	plans: readonly AdapterScanPlanType[],
	previous: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> => {
	const merged = new Map(previous);

	for (const plan of plans) {
		if (plan.scan !== null) {
			merged.set(plan.adapterId, plan.scan.watchInputs ?? []);
		}
	}

	return merged;
};

/**
 * Builds watcher routes from the currently published generation.
 *
 * @param config - Resolved configuration.
 * @param targets - Configured adapters.
 * @param database - Open index database.
 * @param watchInputs - Remembered non-source inputs per adapter.
 * @returns One logical watcher route per adapter.
 */
export const watchRoutesOf = (
	config: ConfigType,
	targets: readonly AdapterTargetType[],
	database: IndexDatabase,
	watchInputs: ReadonlyMap<string, readonly string[]>,
): readonly WatchRouteType[] => adapterWatchRoutes({config, targets, database, published: database.getPublishedGeneration(), watchInputs});

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
