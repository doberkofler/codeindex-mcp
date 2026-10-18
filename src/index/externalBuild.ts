import {setTimeout as delay} from 'node:timers/promises';
import {type IndexDatabase} from '../storage/database.ts';
import {type BuildReportType, type GenerationRowType} from './model.ts';

const EXTERNAL_BUILD_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 150;

const reusedReport = (generation: GenerationRowType): BuildReportType => ({
	generationId: generation.id,
	state: 'published',
	reused: true,
	durationMs: 0,
	fileCount: generation.fileCount,
	symbolCount: generation.symbolCount,
	occurrenceCount: generation.occurrenceCount,
	dependencyEdgeCount: generation.dependencyEdgeCount,
	dependencyBindingCount: generation.dependencyBindingCount,
	diagnosticCount: generation.diagnosticCount,
	stages: null,
});

/**
 * Waits for another process holding the build lease to publish.
 *
 * A reader never builds while another owner holds the lease. It observes the
 * externally published generation and reports reuse.
 *
 * @param input - Database, previously observed generation, and timing hooks.
 * @returns The observed generation report.
 * @throws {@link Error} When no external publication appears before the deadline.
 */
export const observeExternalBuild = async (
	input: Readonly<{
		database: IndexDatabase;
		previous: GenerationRowType | null;
		startedAt: number;
		record?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
	}>,
): Promise<BuildReportType> => {
	const deadline = Date.now() + EXTERNAL_BUILD_TIMEOUT_MS;
	const poll = async (): Promise<BuildReportType> => {
		const published = input.database.getPublishedGeneration();

		if (published !== null && (input.previous === null || published.id !== input.previous.id)) {
			input.record?.('build_observed', {
				durationMs: Math.round(performance.now() - input.startedAt),
				generationChanged: true,
			});
			return reusedReport(published);
		}

		if (Date.now() >= deadline) {
			throw new Error('Another process is building the index; retry after it publishes');
		}

		await delay(POLL_INTERVAL_MS);
		return poll();
	};

	const report = await poll();
	return report;
};
