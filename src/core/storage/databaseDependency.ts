import {type DatabaseSync} from 'node:sqlite';
import {type IndexedDependencyBindingType, type IndexedDependencyEdgeType, type StoredDependencyEdgeType} from '../model.ts';
import {DEPENDENCY_BINDING_COLUMNS, DEPENDENCY_EDGE_COLUMNS, placeholders, toDependencyBinding, toDependencyEdge} from './databaseRows.ts';
import {transaction} from './databaseTransaction.ts';

const TARGET_CHUNK_SIZE = 400;

/**
 * Inserts authored dependency edges for one generation.
 *
 * @param writer - Writer connection.
 * @param generationId - Generation being built.
 * @param edges - Extracted dependency edges.
 */
export const insertDependencyEdges = (writer: DatabaseSync, generationId: string, edges: readonly IndexedDependencyEdgeType[]): void => {
	const statement = writer.prepare(
		`insert into dependency_edge (generation_id, id, source_path, target_path, raw_specifier, normalized_package, kind, type_only,
		 start_line, start_column, end_line, end_column, start_offset, end_offset)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	transaction(writer, () => {
		for (const edge of edges) {
			statement.run(
				generationId,
				edge.id,
				edge.sourcePath,
				edge.targetPath,
				edge.rawSpecifier,
				edge.normalizedPackage,
				edge.kind,
				edge.typeOnly ? 1 : 0,
				edge.startLine,
				edge.startColumn,
				edge.endLine,
				edge.endColumn,
				edge.startOffset,
				edge.endOffset,
			);
		}
	});
};

/**
 * Inserts imported and exported binding details for dependency edges.
 *
 * @param writer - Writer connection.
 * @param generationId - Generation being built.
 * @param bindings - Extracted dependency bindings.
 */
export const insertDependencyBindings = (writer: DatabaseSync, generationId: string, bindings: readonly IndexedDependencyBindingType[]): void => {
	const statement = writer.prepare(
		`insert into dependency_binding (generation_id, edge_id, position, kind, imported_name, exported_name, local_name, type_only)
		 values (?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	transaction(writer, () => {
		for (const binding of bindings) {
			statement.run(
				generationId,
				binding.edgeId,
				binding.position,
				binding.kind,
				binding.importedName,
				binding.exportedName,
				binding.localName,
				binding.typeOnly ? 1 : 0,
			);
		}
	});
};

/**
 * Lists every edge importing or exporting one normalized package.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param packageName - Normalized npm package name.
 * @returns Edges in source and position order.
 */
export const findDependencyEdgesByPackage = (reader: DatabaseSync, generationId: string, packageName: string): readonly StoredDependencyEdgeType[] =>
	reader
		.prepare(
			`select ${DEPENDENCY_EDGE_COLUMNS}
			 from dependency_edge
			 where generation_id = ? and normalized_package = ?
			 order by source_path, start_offset, id`,
		)
		.all(generationId, packageName)
		.map((row) => toDependencyEdge(row, generationId));

/**
 * Lists edges whose resolved authored target is in one module frontier.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param targetPaths - Repository-relative module paths.
 * @returns Edges in source and position order.
 */
export const findDependencyEdgesByTargets = (
	reader: DatabaseSync,
	generationId: string,
	targetPaths: readonly string[],
): readonly StoredDependencyEdgeType[] => {
	const edges: StoredDependencyEdgeType[] = [];

	for (let offset = 0; offset < targetPaths.length; offset += TARGET_CHUNK_SIZE) {
		const chunk = targetPaths.slice(offset, offset + TARGET_CHUNK_SIZE);
		const rows = reader
			.prepare(
				`select ${DEPENDENCY_EDGE_COLUMNS}
				 from dependency_edge
				 where generation_id = ? and target_path in (${placeholders(chunk.length)})
				 order by source_path, start_offset, id`,
			)
			.all(generationId, ...chunk);

		edges.push(...rows.map((row) => toDependencyEdge(row, generationId)));
	}

	return edges;
};

/**
 * Lists binding details for selected evidence edges.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param edgeIds - Evidence edge identifiers.
 * @returns Bindings in edge and position order.
 */
export const listDependencyBindings = (reader: DatabaseSync, generationId: string, edgeIds: readonly string[]): readonly IndexedDependencyBindingType[] => {
	if (edgeIds.length === 0) {
		return [];
	}

	return reader
		.prepare(
			`select ${DEPENDENCY_BINDING_COLUMNS}
			 from dependency_binding
			 where generation_id = ? and edge_id in (${placeholders(edgeIds.length)})
			 order by edge_id, position`,
		)
		.all(generationId, ...edgeIds)
		.map((row) => toDependencyBinding(row));
};
