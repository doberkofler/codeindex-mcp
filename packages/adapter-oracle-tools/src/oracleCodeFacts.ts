import {type DatabaseSync} from 'node:sqlite';
import {ORACLE_DIAGNOSTIC} from '@codeindex/adapter-oracle/internals';
import {asNumber, asString} from '../../../src/core/storage/databaseRows.ts';
import {type CodeOccurrenceType} from './oracleTruth.ts';
import {positionKeyOf} from './oracleTruthExclusions.ts';

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
			`select s.name, s.kind, symbol_file.path as symbol_path, s.start_line as symbol_line, s.start_column as symbol_column,
			        occurrence_file.path, o.start_line, o.start_column, o.role
			 from occurrence o
			 join symbol s on s.symbol_key = o.symbol_key
			 join file symbol_file on symbol_file.file_key = s.file_key
			 join file occurrence_file on occurrence_file.file_key = o.file_key
			 where o.generation_key = (select generation_key from generation where id = ?)`,
		)
		.all(generationId);

	for (const row of rows) {
		const value: CodeOccurrenceType = {
			path: asString(row, 'path'),
			line: asNumber(row, 'start_line'),
			column: asNumber(row, 'start_column'),
			name: asString(row, 'name'),
			kind: asString(row, 'kind'),
			symbolPath: asString(row, 'symbol_path'),
			symbolLine: asNumber(row, 'symbol_line'),
			symbolColumn: asNumber(row, 'symbol_column'),
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
 * Loads the authored positions of emitted ambiguous-overload diagnostics.
 *
 * Each site is a `CALL` whose target the adapter deliberately leaves
 * unresolved. The contract pairs such a site with its exact PL/Scope row and
 * omits that row from the truth denominator with a counted reason.
 *
 * @param database - Read-only index connection.
 * @param generationId - Published generation.
 * @returns Position-only keys for every ambiguous-overload diagnostic.
 */
export const loadAmbiguousOverloadSites = (database: DatabaseSync, generationId: string): ReadonlySet<string> => {
	const rows = database
		.prepare(
			`select coalesce(f.path, d.fallback_path) path, d.start_line, d.start_column
			 from diagnostic d
			 left join file f on f.file_key = d.file_key
			 where d.generation_key = (select generation_key from generation where id = ?)
			 and d.code = ?
			 and coalesce(f.path, d.fallback_path) is not null
			 and d.start_line is not null
			 and d.start_column is not null`,
		)
		.all(generationId, ORACLE_DIAGNOSTIC.ambiguousOverload);

	return new Set(rows.map((row) => positionKeyOf({path: asString(row, 'path'), line: asNumber(row, 'start_line'), column: asNumber(row, 'start_column')})));
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
			`select source.path as source_path, e.target_identifier
			 from dependency_edge e
			 join file source on source.file_key = e.source_file_key
			 where e.generation_key = (select generation_key from generation where id = ?)
			 and e.target_identifier is not null
			 and e.kind in ('package-call', 'package-reference', 'type-reference')`,
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
