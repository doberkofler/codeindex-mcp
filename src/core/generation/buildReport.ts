import {type AdapterCommitCountsType} from '../storage/database.ts';
import {type BuildOutcomeType, type BuildReportType, type BuildStagesType, type GenerationRowType} from '../model.ts';

/**
 * Creates the published report for one successful attempt.
 *
 * @param input - Generation identity, outcome, timing, counts, and stages.
 * @returns The published build report.
 */
export const createReport = (
	input: Readonly<{
		generationId: string;
		revision: number;
		outcome: Exclude<BuildOutcomeType, 'failed'>;
		reused: boolean;
		durationMs: number;
		counts: AdapterCommitCountsType;
		stages: BuildStagesType | null;
	}>,
): BuildReportType => ({
	generationId: input.generationId,
	revision: input.revision,
	state: 'published',
	outcome: input.outcome,
	reused: input.reused,
	durationMs: input.durationMs,
	fileCount: input.counts.files,
	symbolCount: input.counts.symbols,
	occurrenceCount: input.counts.occurrences,
	dependencyEdgeCount: input.counts.dependencyEdges,
	dependencyBindingCount: input.counts.dependencyBindings,
	diagnosticCount: input.counts.diagnostics,
	stages: input.stages,
});

/**
 * Projects persisted generation counts into adapter commit counts.
 *
 * @param generation - Published generation row.
 * @returns Commit counts.
 */
export const countsOf = (generation: GenerationRowType): AdapterCommitCountsType => ({
	files: generation.fileCount,
	symbols: generation.symbolCount,
	occurrences: generation.occurrenceCount,
	dependencyEdges: generation.dependencyEdgeCount,
	dependencyBindings: generation.dependencyBindingCount,
	diagnostics: generation.diagnosticCount,
});

const stageTotalOf = (stages: BuildStagesType | null): number =>
	stages === null ? 0 : stages.scanMs + stages.compilerMs + stages.extractionMs + stages.insertionMs + stages.verificationMs + stages.publicationMs;

/**
 * Keeps the reported attempt at least as long as its independently rounded stages.
 *
 * @param startedAt - Epoch milliseconds when the attempt started.
 * @param stages - Exclusive stage durations, or null when nothing was measured.
 * @returns Wall-clock duration in milliseconds.
 */
export const durationOf = (startedAt: number, stages: BuildStagesType | null): number => Math.max(Math.round(Date.now() - startedAt), stageTotalOf(stages));
