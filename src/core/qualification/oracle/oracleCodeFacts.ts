import {type DatabaseSync} from 'node:sqlite';
import {asNumber, asString} from '../../storage/databaseRows.ts';
import {type CodeOccurrenceType} from './oracleTruth.ts';

export type CodeFactsType = Readonly<{
	definitions: ReadonlyMap<string, CodeOccurrenceType>;
	references: ReadonlyMap<string, CodeOccurrenceType>;
}>;

const keyOf = (value: CodeOccurrenceType): string => `${value.path}:${String(value.line)}:${String(value.column)}:${value.name.toLowerCase()}`;

/**
 * Loads all indexed definitions and references for one generation.
 *
 * @param database - Read-only index connection.
 * @param generationId - Published generation.
 * @returns Definition and reference maps.
 */
export const loadCodeFacts = (database: DatabaseSync, generationId: string): CodeFactsType => {
	const definitions = new Map<string, CodeOccurrenceType>();
	const references = new Map<string, CodeOccurrenceType>();
	const rows = database
		.prepare(
			`select s.name, s.kind, o.path, o.start_line, o.start_column, o.role
			 from occurrence o
			 join symbol s on s.generation_id = o.generation_id and s.id = o.symbol_id
			 where o.generation_id = ?`,
		)
		.all(generationId);

	for (const row of rows) {
		const value: CodeOccurrenceType = {
			path: asString(row, 'path'),
			line: asNumber(row, 'start_line'),
			column: asNumber(row, 'start_column'),
			name: asString(row, 'name'),
			kind: asString(row, 'kind'),
		};
		const key = keyOf(value);

		if (asString(row, 'role') === 'definition') {
			definitions.set(key, value);
		} else {
			references.set(key, value);
		}
	}

	return {definitions, references};
};

/**
 * Loads internal package dependency edges for one generation.
 *
 * @param database - Read-only index connection.
 * @param generationId - Published generation.
 * @param packageNames - Package names present in the qualification corpus.
 * @param packageByPath - Package name for each source path.
 * @returns Deduplicated source-path/target-package edges.
 */
export const loadCodeDependencies = (
	database: DatabaseSync,
	generationId: string,
	packageNames: ReadonlySet<string>,
	packageByPath: ReadonlyMap<string, string>,
): ReadonlySet<string> => {
	const dependencies = new Set<string>();
	const rows = database
		.prepare(
			`select source_path, target_identifier
			 from dependency_edge
			 where generation_id = ?
			 and target_identifier is not null
			 and kind in ('package-call', 'package-reference', 'type-reference')`,
		)
		.all(generationId);

	for (const row of rows) {
		const sourcePath = asString(row, 'source_path');
		const target = (asString(row, 'target_identifier').split('.').at(-1) ?? '').toLowerCase();

		if (packageNames.has(target) && target !== packageByPath.get(sourcePath)) {
			dependencies.add(`${sourcePath}\u0000${target}`);
		}
	}

	return dependencies;
};
