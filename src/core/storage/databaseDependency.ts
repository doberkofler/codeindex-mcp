import {type DatabaseSync} from 'node:sqlite';
import {type IndexedDependencyBindingType, type StoredDependencyEdgeType} from '../model.ts';
import {DEPENDENCY_BINDING_COLUMNS, DEPENDENCY_EDGE_COLUMNS, placeholders, toDependencyBinding, toDependencyEdge} from './databaseRows.ts';

const TARGET_CHUNK_SIZE = 400;

/**
 * Lists every edge importing or exporting one normalized package.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param targetIdentifier - Normalized npm package name.
 * @param context - Optional project-context filter.
 * @returns Edges in source and position order.
 */
export const findDependencyEdgesByTargetIdentifier = (
	reader: DatabaseSync,
	generationId: string,
	targetIdentifier: string,
	context?: string,
): readonly StoredDependencyEdgeType[] => {
	const contextClause = context === undefined ? '' : ' and context_name = ?';
	const parameters = context === undefined ? [generationId, targetIdentifier] : [generationId, targetIdentifier, context];

	return reader
		.prepare(
			`select ${DEPENDENCY_EDGE_COLUMNS}
			 from dependency_edge
			 where generation_id = ? and target_identifier = ?${contextClause}
			 order by source_path, start_offset, id`,
		)
		.all(...parameters)
		.map((row) => toDependencyEdge(row, generationId));
};

/**
 * Lists edges whose resolved authored target is in one module frontier.
 *
 * @param reader - Reader connection.
 * @param generationId - Published generation.
 * @param targetPaths - Repository-relative module paths.
 * @param context - Optional project-context filter.
 * @returns Edges in source and position order.
 */
export const findDependencyEdgesByTargets = (
	reader: DatabaseSync,
	generationId: string,
	targetPaths: readonly string[],
	context?: string,
): readonly StoredDependencyEdgeType[] => {
	const edges: StoredDependencyEdgeType[] = [];
	const contextClause = context === undefined ? '' : ' and context_name = ?';
	const contextParameters = context === undefined ? [] : [context];

	for (let offset = 0; offset < targetPaths.length; offset += TARGET_CHUNK_SIZE) {
		const chunk = targetPaths.slice(offset, offset + TARGET_CHUNK_SIZE);
		const rows = reader
			.prepare(
				`select ${DEPENDENCY_EDGE_COLUMNS}
				 from dependency_edge
				 where generation_id = ? and target_path in (${placeholders(chunk.length)})${contextClause}
				 order by source_path, start_offset, id`,
			)
			.all(generationId, ...chunk, ...contextParameters);

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
