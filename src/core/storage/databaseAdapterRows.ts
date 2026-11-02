import {type DatabaseSync} from 'node:sqlite';
import {type AdapterCommitCountsType, type AdapterCommitType} from './databaseCommitTypes.ts';

/**
 * Deletes every row owned by one adapter within a generation.
 *
 * File deletion cascades symbols, occurrences, bindings, sites, and contexts.
 * Tables without a file or symbol parent are cleared explicitly.
 *
 * @param writer - Writer connection inside an open transaction.
 * @param generationId - Generation whose adapter rows are removed.
 * @param adapterId - Adapter to remove.
 */
export const deleteAdapterRows = (writer: DatabaseSync, generationId: string, adapterId: string): void => {
	writer.prepare('delete from file where generation_id = ? and adapter_id = ?').run(generationId, adapterId);

	for (const table of ['dependency_edge', 'diagnostic', 'build_stats', 'generation_file_digest', 'project_context', 'generation_adapter']) {
		writer.prepare(`delete from ${table} where generation_id = ? and adapter_id = ?`).run(generationId, adapterId);
	}
};

/**
 * Inserts or revises one per-adapter provenance row.
 *
 * @param writer - Writer connection inside an open transaction.
 * @param input - Generation, adapter contribution, resolved counts, and stages.
 */
export const upsertAdapterRow = (
	writer: DatabaseSync,
	input: Readonly<{
		generationId: string;
		adapter: AdapterCommitType;
		counts: AdapterCommitCountsType;
		stages: Readonly<{scanMs: number; compilerMs: number; extractionMs: number}>;
	}>,
): void => {
	const {adapter} = input;

	writer
		.prepare(
			`insert into generation_adapter (
				generation_id, adapter_id, adapter_version, compiler_version, declared_compiler_version, compiler_drift,
				coverage, absence_reason, source_hash, config_hash, input_hash,
				file_count, symbol_count, occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count,
				scan_ms, compiler_ms, extraction_ms)
			 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 on conflict(generation_id, adapter_id) do update set
			 	adapter_version = excluded.adapter_version,
			 	compiler_version = excluded.compiler_version,
			 	declared_compiler_version = excluded.declared_compiler_version,
			 	compiler_drift = excluded.compiler_drift,
			 	coverage = excluded.coverage,
			 	absence_reason = excluded.absence_reason,
			 	source_hash = excluded.source_hash,
			 	config_hash = excluded.config_hash,
			 	input_hash = excluded.input_hash,
			 	file_count = excluded.file_count,
			 	symbol_count = excluded.symbol_count,
			 	occurrence_count = excluded.occurrence_count,
			 	dependency_edge_count = excluded.dependency_edge_count,
			 	dependency_binding_count = excluded.dependency_binding_count,
			 	diagnostic_count = excluded.diagnostic_count,
			 	scan_ms = excluded.scan_ms,
			 	compiler_ms = excluded.compiler_ms,
			 	extraction_ms = excluded.extraction_ms`,
		)
		.run(
			input.generationId,
			adapter.adapterId,
			adapter.adapterVersion,
			adapter.compilerVersion,
			adapter.declaredCompilerVersion,
			adapter.compilerDrift ? 1 : 0,
			adapter.coverage,
			adapter.absenceReason,
			adapter.sourceHash,
			adapter.configHash,
			adapter.inputHash,
			input.counts.files,
			input.counts.symbols,
			input.counts.occurrences,
			input.counts.dependencyEdges,
			input.counts.dependencyBindings,
			input.counts.diagnostics,
			input.stages.scanMs,
			input.stages.compilerMs,
			input.stages.extractionMs,
		);
};
