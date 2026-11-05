import {type DatabaseSync} from 'node:sqlite';
import {type AdapterCommitCountsType} from './databaseCommitTypes.ts';
import {asNumber} from './databaseRows.ts';

/**
 * Sums the persisted per-adapter counts for one generation.
 *
 * A targeted refresh writes only the invalidated adapters. The generation-level
 * totals therefore come from every stored adapter row, not from the written
 * subset, so a partial publication keeps the aggregate counts complete.
 *
 * @param writer - Writer connection inside the publication transaction.
 * @param generationId - Generation whose adapter rows are summed.
 * @returns Aggregate counts, or null when the generation has no adapter row.
 */
export const persistedAdapterCounts = (writer: DatabaseSync, generationId: string): AdapterCommitCountsType | null => {
	const row = writer
		.prepare(
			`select count(*) as adapter_count,
			        coalesce(sum(file_count), 0) as file_count,
			        coalesce(sum(symbol_count), 0) as symbol_count,
			        coalesce(sum(occurrence_count), 0) as occurrence_count,
			        coalesce(sum(dependency_edge_count), 0) as dependency_edge_count,
			        coalesce(sum(dependency_binding_count), 0) as dependency_binding_count,
			        coalesce(sum(diagnostic_count), 0) as diagnostic_count
			 from generation_adapter where generation_id = ?`,
		)
		.get(generationId);

	if (row === undefined || asNumber(row, 'adapter_count') === 0) {
		return null;
	}

	return {
		files: asNumber(row, 'file_count'),
		symbols: asNumber(row, 'symbol_count'),
		occurrences: asNumber(row, 'occurrence_count'),
		dependencyEdges: asNumber(row, 'dependency_edge_count'),
		dependencyBindings: asNumber(row, 'dependency_binding_count'),
		diagnostics: asNumber(row, 'diagnostic_count'),
	};
};

/**
 * Sums the persisted per-adapter stage timings for one generation.
 *
 * @param writer - Writer connection inside the publication transaction.
 * @param generationId - Generation whose adapter rows are summed.
 * @returns Aggregate adapter stages.
 */
export const persistedAdapterStages = (writer: DatabaseSync, generationId: string): Readonly<{scanMs: number; compilerMs: number; extractionMs: number}> => {
	const row = writer
		.prepare(
			`select coalesce(sum(scan_ms), 0) as scan_ms,
			        coalesce(sum(compiler_ms), 0) as compiler_ms,
			        coalesce(sum(extraction_ms), 0) as extraction_ms
			 from generation_adapter where generation_id = ?`,
		)
		.get(generationId);

	return {
		scanMs: row === undefined ? 0 : asNumber(row, 'scan_ms'),
		compilerMs: row === undefined ? 0 : asNumber(row, 'compiler_ms'),
		extractionMs: row === undefined ? 0 : asNumber(row, 'extraction_ms'),
	};
};
