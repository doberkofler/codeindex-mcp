import {type GenerationRowType, type IndexVerificationType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';

/**
 * Checks one published generation's SQLite integrity and stored row counts.
 *
 * The check runs inside a read snapshot so integrity, counts, and metadata are
 * read from the same revision.
 *
 * @param database - Index database.
 * @param generation - Published generation to verify.
 * @returns Integrity status and persisted row counts.
 * @throws {@link Error} When SQLite reports an integrity, foreign-key, or count problem.
 */
export const verifyPublishedIndex = (database: IndexDatabase, generation: GenerationRowType): IndexVerificationType => {
	database.verifyIntegrity();

	const counts = {
		files: database.countRows(generation.id, 'file'),
		symbols: database.countRows(generation.id, 'symbol'),
		occurrences: database.countRows(generation.id, 'occurrence'),
		dependencyEdges: database.countRows(generation.id, 'dependency_edge'),
		dependencyBindings: database.countRows(generation.id, 'dependency_binding'),
		diagnostics: database.countRows(generation.id, 'diagnostic'),
	};
	const metadataMatches =
		counts.files === generation.fileCount &&
		counts.symbols === generation.symbolCount &&
		counts.occurrences === generation.occurrenceCount &&
		counts.dependencyEdges === generation.dependencyEdgeCount &&
		counts.dependencyBindings === generation.dependencyBindingCount &&
		counts.diagnostics === generation.diagnosticCount;

	if (!metadataMatches) {
		throw new Error(
			`Index metadata counts do not match stored rows: files ${counts.files}/${generation.fileCount}, symbols ${counts.symbols}/${generation.symbolCount}, occurrences ${counts.occurrences}/${generation.occurrenceCount}, dependency edges ${counts.dependencyEdges}/${generation.dependencyEdgeCount}, dependency bindings ${counts.dependencyBindings}/${generation.dependencyBindingCount}, diagnostics ${counts.diagnostics}/${generation.diagnosticCount}`,
		);
	}

	return {generationId: generation.id, integrity: 'ok', metadataMatches, counts};
};
