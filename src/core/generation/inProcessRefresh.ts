import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type ConfigType} from '../config/config.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildReportType} from '../model.ts';
import {startProcessSample} from '../resources/processSample.ts';
import {BUILD_LEASE_TTL_MS, type IndexDatabase} from '../storage/database.ts';
import {type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {adapterTargetsForScope, planAdapterScans} from './adapterRefresh.ts';
import {buildFailureOf, buildProjectContextOfScan} from './buildFailure.ts';
import {startBuildLeaseHeartbeat} from './buildLeaseHeartbeat.ts';
import {acquireOrObserveBuildLease, externalBuildReport} from './externalBuild.ts';
import {recordFailedRefresh, recordRefreshOutcome} from './refreshTelemetry.ts';

const LEASE_RENEW_MS = 3000;

type InputType = Readonly<{
	reason: 'startup' | 'change' | 'reconcile' | 'manual';
	force: boolean;
	adapterIds: readonly string[] | null;
	signal: AbortSignal;
	config: ConfigType;
	database: IndexDatabase;
	logger: LoggerType;
	analytics: AnalyticsRecorderType | null;
	ownerId: string;
	targets: readonly AdapterTargetType[];
	compilerDriftObserved: Set<string>;
	build: (plans: readonly AdapterScanPlanType[], startedAtEpoch: number) => Promise<BuildReportType>;
}>;

export type InProcessRefreshResultType = Readonly<{
	report: BuildReportType;
	plans: readonly AdapterScanPlanType[];
}>;

/**
 * Runs the qualification-only write lifecycle without a worker.
 *
 * @param input - In-process configuration and lifecycle dependencies.
 * @returns Build report and discovered scan plans.
 */
export const runInProcessRefresh = async (input: InputType): Promise<InProcessRefreshResultType> => {
	const startedAt = performance.now();
	const startedAtEpoch = Date.now();
	const targets = adapterTargetsForScope(input.targets, input.adapterIds);
	const leaseOutcome = await acquireOrObserveBuildLease({
		database: input.database,
		requestedAdapterIds: targets.map((target) => target.adapter.id),
		startedAt,
		signal: input.signal,
		tryAcquire: () => input.database.tryAcquireBuildLease(input.ownerId, process.pid, BUILD_LEASE_TTL_MS),
		record: (event, fields) => {
			input.analytics?.record(event, fields);
		},
	});
	const externalReport = externalBuildReport(leaseOutcome, input.database, startedAtEpoch);

	if (externalReport !== null) {
		return {report: externalReport, plans: []};
	}

	const stopHeartbeat = startBuildLeaseHeartbeat({
		renew: () => input.database.renewBuildLease(input.ownerId, BUILD_LEASE_TTL_MS),
		intervalMs: LEASE_RENEW_MS,
		onFailure: (failure, error): void => {
			input.logger.debug('build lease renewal skipped', {failure, message: error instanceof Error ? error.message : null});
		},
	});
	const sample = startProcessSample();
	const resources = (): Readonly<Record<string, number>> => ({...sample.stop(), databaseBytes: input.database.databaseSizeBytes()});
	let plans: readonly AdapterScanPlanType[] = [];

	try {
		const published = input.database.getPublishedGeneration();
		plans = await planAdapterScans({
			config: input.config,
			targets,
			database: input.database,
			published,
			logger: input.logger,
			analytics: input.analytics,
			observed: input.compilerDriftObserved,
		});
		const report = await input.build(plans, startedAtEpoch);
		recordRefreshOutcome({
			logger: input.logger,
			analytics: input.analytics,
			reason: input.reason,
			durationMs: report.durationMs,
			resources: resources(),
			report,
		});
		return {report, plans};
	} catch (error) {
		recordFailedRefresh({
			logger: input.logger,
			analytics: input.analytics,
			reason: input.reason,
			durationMs: Math.round(performance.now() - startedAt),
			message: error instanceof Error ? error.message : String(error),
			failure: buildFailureOf(
				error,
				'scan',
				buildProjectContextOfScan(plans.find((plan) => plan.scan !== null)?.scan ?? null),
				plans.length === 1 ? (plans[0]?.adapterId ?? null) : null,
			),
			resources: resources(),
		});
		throw error;
	} finally {
		sample.stop();
		stopHeartbeat();

		try {
			input.database.releaseBuildLease(input.ownerId);
		} catch {
			// The lease may already have been taken over; publication remains authoritative.
		}
	}
};
