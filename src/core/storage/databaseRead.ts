import {type DatabaseSync} from 'node:sqlite';
import {type AdapterStagesType, type GenerationAdapterType, type GenerationRowType} from '../model.ts';
import {asNumber, asString, toGeneration} from './databaseRows.ts';

/**
 * Reads per-adapter provenance for one generation.
 *
 * @param reader - Reader connection.
 * @param generationId - Candidate or published generation.
 * @returns Adapter rows ordered by adapter identifier.
 */
export const readGenerationAdapters = (reader: DatabaseSync, generationId: string): readonly GenerationAdapterType[] => {
	const rows = reader.prepare('select * from generation_adapter where generation_id = ? order by adapter_id').all(generationId);

	return rows.map((row) => {
		const scanMs = typeof row['scan_ms'] === 'number' ? row['scan_ms'] : null;
		const stages: AdapterStagesType | null =
			scanMs === null
				? null
				: {
						scanMs,
						compilerMs: asNumber(row, 'compiler_ms'),
						extractionMs: asNumber(row, 'extraction_ms'),
					};

		return {
			adapterId: asString(row, 'adapter_id'),
			adapterVersion: asString(row, 'adapter_version'),
			compilerVersion: asString(row, 'compiler_version'),
			declaredCompilerVersion: typeof row['declared_compiler_version'] === 'string' ? row['declared_compiler_version'] : null,
			compilerDrift: asNumber(row, 'compiler_drift') !== 0,
			coverage: row['coverage'] === 'absent' ? 'absent' : 'present',
			absenceReason: typeof row['absence_reason'] === 'string' ? row['absence_reason'] : null,
			sourceHash: asString(row, 'source_hash'),
			configHash: asString(row, 'config_hash'),
			inputHash: asString(row, 'input_hash'),
			fileCount: asNumber(row, 'file_count'),
			symbolCount: asNumber(row, 'symbol_count'),
			occurrenceCount: asNumber(row, 'occurrence_count'),
			dependencyEdgeCount: asNumber(row, 'dependency_edge_count'),
			dependencyBindingCount: asNumber(row, 'dependency_binding_count'),
			diagnosticCount: asNumber(row, 'diagnostic_count'),
			stages,
		};
	});
};

/**
 * Reads one generation by identifier.
 *
 * @param reader - Reader connection.
 * @param id - Generation identifier.
 * @returns The generation row, or null when absent.
 */
export const readGeneration = (reader: DatabaseSync, id: string): GenerationRowType | null => {
	const row = reader.prepare('select * from generation where id = ?').get(id);
	return row === undefined ? null : toGeneration(row);
};

/**
 * Reads the currently published generation.
 *
 * @param reader - Reader connection.
 * @returns The published generation, or null when none is published.
 */
export const readPublishedGeneration = (reader: DatabaseSync): GenerationRowType | null => {
	const row = reader
		.prepare(
			`select g.* from generation g
			 join metadata m on m.value = g.id
			 where m.key = 'current_generation' and g.state = 'published'`,
		)
		.get();

	return row === undefined ? null : toGeneration(row);
};

/**
 * Finds a published generation with matching source, configuration, and input hashes.
 *
 * @param reader - Reader connection.
 * @param sourceHash - Source-set hash.
 * @param configHash - Configuration hash.
 * @param inputHash - Declaration and module-resolution input hash; defaults to `configHash` for adapters that do not distinguish it.
 * @returns The reusable generation, or null.
 */
export const findReusableGeneration = (
	reader: DatabaseSync,
	sourceHash: string,
	configHash: string,
	inputHash: string = configHash,
): GenerationRowType | null => {
	const row = reader
		.prepare(
			`select * from generation
			 where state = 'published' and source_hash = ? and config_hash = ? and coalesce(nullif(input_hash, ''), config_hash) = ?
			 order by completed_at desc limit 1`,
		)
		.get(sourceHash, configHash, inputHash);

	return row === undefined ? null : toGeneration(row);
};
