import {type AdapterCommitCountsType, type AdapterCommitType} from '../storage/database.ts';
import {type AdapterActivityType, type BuildOutcomeType, type BuildReportType, type BuildStagesType, type GenerationRowType} from '../model.ts';

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
		adapterActivity?: readonly AdapterActivityType[];
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
	...(input.adapterActivity === undefined ? {} : {adapterActivity: input.adapterActivity}),
});

const factWritesOf = (adapter: AdapterCommitType): number => {
	const rows = [
		adapter.facts?.symbols,
		adapter.facts?.occurrences,
		adapter.facts?.bindings,
		adapter.facts?.bindingContexts,
		adapter.facts?.bindingSites,
		adapter.facts?.surfaceOrigins,
		adapter.dependencies?.edges,
		adapter.dependencies?.bindings,
		adapter.diagnostics,
	];

	return rows.reduce((total, row) => total + (row?.length ?? 0), 0);
};

/**
 * Projects committed adapter contributions into benchmark-visible work.
 *
 * A contribution without finalized facts reused the published rows and
 * performed no extraction. Counting emitted rows describes how many fact rows
 * the adapter was about to write, independent of the build worker process.
 *
 * @param adapters - Committed adapter contributions.
 * @returns One activity entry per contribution.
 */
export const adapterActivityOf = (adapters: readonly AdapterCommitType[]): readonly AdapterActivityType[] =>
	adapters.map((adapter) => ({
		adapterId: adapter.adapterId,
		extractions: adapter.facts === undefined ? 0 : 1,
		factWrites: factWritesOf(adapter),
	}));

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
