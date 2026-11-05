import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BuildReportType} from '../model.ts';
import {type BuildFailureType} from './buildFailure.ts';

type RefreshTelemetryInputType = Readonly<{
	readonly logger: LoggerType;
	readonly analytics: AnalyticsRecorderType | null;
	readonly reason: string;
	readonly durationMs: number;
	readonly resources: Readonly<Record<string, number>>;
}>;

const recordSafely = (analytics: AnalyticsRecorderType | null, event: string, fields: Readonly<Record<string, unknown>>): void => {
	analytics?.record(event, fields);
};

/**
 * Records one published or reused refresh.
 *
 * @param input - Logger, analytics sink, refresh reason, report, and resources.
 */
const recordPublishedRefresh = (input: RefreshTelemetryInputType & Readonly<{report: BuildReportType}>): void => {
	const {report} = input;
	input.logger.info('index_ready', {
		generationId: report.generationId,
		reused: report.reused,
		durationMs: report.durationMs,
		files: report.fileCount,
		symbols: report.symbolCount,
		occurrences: report.occurrenceCount,
	});
	recordSafely(input.analytics, report.reused ? 'build_reused' : 'build_complete', {
		reason: input.reason,
		durationMs: report.durationMs,
		fileCount: report.fileCount,
		symbolCount: report.symbolCount,
		occurrenceCount: report.occurrenceCount,
		stages: report.stages,
		...(report.adapterActivity === undefined ? {} : {adapterActivity: report.adapterActivity}),
		...input.resources,
	});
};

/**
 * Records one superseded refresh.
 *
 * Supersession is not a failure: the captured inputs changed mid-build, so the
 * candidate was discarded and the coordinator scheduled a retry. No
 * `build_failed` event is emitted.
 *
 * @param input - Logger, analytics sink, refresh reason, report, and resources.
 */
const recordSupersededRefresh = (input: RefreshTelemetryInputType & Readonly<{report: BuildReportType}>): void => {
	const {report} = input;
	input.logger.info('index_superseded', {
		generationId: report.generationId,
		durationMs: report.durationMs,
		files: report.fileCount,
	});
	recordSafely(input.analytics, 'build_superseded', {
		reason: input.reason,
		durationMs: report.durationMs,
		fileCount: report.fileCount,
		symbolCount: report.symbolCount,
		occurrenceCount: report.occurrenceCount,
		...input.resources,
	});
};

/**
 * Records one completed attempt under its actual outcome.
 *
 * @param input - Logger, analytics sink, reason, report, and resources.
 */
export const recordRefreshOutcome = (input: RefreshTelemetryInputType & Readonly<{report: BuildReportType}>): void => {
	if (input.report.outcome === 'superseded') {
		recordSupersededRefresh(input);
		return;
	}

	recordPublishedRefresh(input);
};

/**
 * Records one failed refresh with bounded cause, stage, and errno.
 *
 * @param input - Logger, analytics sink, reason, duration, failure, and resources.
 */
export const recordFailedRefresh = (
	input: Readonly<{
		readonly logger: LoggerType;
		readonly analytics: AnalyticsRecorderType | null;
		readonly reason: string;
		readonly durationMs: number;
		readonly message: string;
		readonly failure: BuildFailureType;
		readonly resources: Readonly<Record<string, number>>;
	}>,
): void => {
	input.logger.error('index_refresh_failed', {
		message: input.message,
		cause: input.failure.cause,
		stage: input.failure.stage,
		errno: input.failure.errno,
		adapter: input.failure.adapter,
	});
	recordSafely(input.analytics, 'build_failed', {
		reason: input.reason,
		cause: input.failure.cause,
		stage: input.failure.stage,
		errno: input.failure.errno,
		adapter: input.failure.adapter,
		durationMs: input.durationMs,
		...input.resources,
	});
};
