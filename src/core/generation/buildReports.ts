import {type LoggerType} from '../logging/logger.ts';
import {type BuildReportType, type GenerationRowType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {type AdapterScanPlanType} from './adapterBuild.ts';
import {ZERO_COUNTS} from './adapterCommit.ts';
import {type BuildProjectContextType, buildFailureOf, buildProjectContextOf} from './buildFailure.ts';
import {countsOf, createReport} from './buildReport.ts';

/**
 * Resolves the first available project context for bounded failure telemetry.
 *
 * @param plans - Adapter scan plans.
 * @returns Workspace-relative project identity, or null when no project was scanned.
 */
const projectContextOf = (plans: readonly AdapterScanPlanType[]): BuildProjectContextType | null => {
	const scan = plans.find((plan) => plan.scan !== null)?.scan ?? null;
	return scan === null ? null : buildProjectContextOf(scan.projects);
};

/**
 * Creates the report for a reused published generation.
 *
 * @param reusable - Generation whose fingerprints still match.
 * @param startedAt - Epoch milliseconds when the attempt started.
 * @returns The reused build report.
 */
export const reusedReport = (reusable: GenerationRowType, startedAt: number): BuildReportType =>
	createReport({
		generationId: reusable.id,
		revision: reusable.revision,
		outcome: 'reused',
		reused: true,
		durationMs: Math.round(Date.now() - startedAt),
		counts: countsOf(reusable),
		stages: null,
	});

/**
 * Creates the report for a candidate that was discarded instead of published.
 *
 * @param input - Generation identity, previous publication, and attempt start.
 * @returns The superseded build report.
 */
export const supersededReport = (
	input: Readonly<{
		generationId: string;
		published: GenerationRowType | null;
		startedAt: number;
	}>,
): BuildReportType =>
	createReport({
		generationId: input.published?.id ?? input.generationId,
		revision: input.published?.revision ?? 0,
		outcome: 'superseded',
		reused: false,
		durationMs: Math.round(Date.now() - input.startedAt),
		counts: input.published === null ? ZERO_COUNTS : countsOf(input.published),
		stages: null,
	});

/**
 * Classifies a failed candidate, discarding superseded attempts.
 *
 * @param input - Error, generation mode, previous publication, scans, and sinks.
 * @returns The superseded report when the captured source changed.
 * @throws {unknown} The original error for every non-superseded failure.
 */
export const failedBuild = (
	input: Readonly<{
		error: unknown;
		generationId: string;
		mode: 'insert' | 'revise';
		published: GenerationRowType | null;
		scans: readonly AdapterScanPlanType[];
		startedAt: number;
		database: IndexDatabase;
		logger: LoggerType;
	}>,
): BuildReportType => {
	const {error} = input;
	const failure = buildFailureOf(error, 'publication', projectContextOf(input.scans), input.scans.length === 1 ? (input.scans[0]?.adapterId ?? null) : null);

	// A candidate whose captured inputs changed is discarded. The previous
	// published revision stays in place and the caller retries.
	if (failure.cause === 'source-changed') {
		if (input.mode === 'insert') {
			input.database.discardBuildingGeneration(input.generationId);
		}

		const report = supersededReport({generationId: input.generationId, published: input.published, startedAt: input.startedAt});
		input.logger.info('index_build_superseded', {generationId: input.generationId, stage: failure.stage, durationMs: report.durationMs});
		return report;
	}

	const message = error instanceof Error ? error.message : String(error);
	input.logger.error('index_build_failed', {
		generationId: input.generationId,
		message,
		cause: failure.cause,
		stage: failure.stage,
		errno: failure.errno,
		adapter: failure.adapter,
	});

	if (input.mode === 'insert') {
		input.database.markFailed(input.generationId, message);
	}

	throw error;
};
