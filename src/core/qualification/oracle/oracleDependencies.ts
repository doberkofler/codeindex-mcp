import {objectKey, type ObjectMappingType} from './oracleMapping.ts';
import {emptyDependencyExclusionCounts, type DependencyExclusionCountsType, type OracleDependencyExclusionReasonType} from './oracleDependencyExclusions.ts';

export type ExcludedDependencyType = Readonly<{
	path: string;
	target: string;
	reason: OracleDependencyExclusionReasonType;
}>;

export type TruthDependenciesType = Readonly<{
	/** Truth edges that name their target package in authored source. */
	edges: ReadonlySet<string>;
	/** Truth edges before the contract's dependency exclusions. */
	rawEdges: number;
	/** Omitted truth edges with one counted reason each. */
	excluded: readonly ExcludedDependencyType[];
	excludedByReason: DependencyExclusionCountsType;
}>;

export type ReadTruthDependenciesOptionsType = Readonly<{
	/** Returns the authored source for a workspace-relative POSIX path. */
	sourceOf: (sourcePath: string) => string;
}>;

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const mentionsIdentifier = (source: string, identifier: string): boolean =>
	new RegExp(`(?<![A-Za-z0-9_$#])${escapeRegExp(identifier)}(?![A-Za-z0-9_$#])`, 'iu').test(source);

const candidateEdgeOf = (row: readonly string[], mappings: ReadonlyMap<string, ObjectMappingType>, packageNames: ReadonlySet<string>): string | null => {
	if (row.length < 6) {
		return null;
	}

	const [name = '', sourceType = '', , referencedName = '', referencedType = ''] = row;

	if (referencedType.toUpperCase() !== 'PACKAGE') {
		return null;
	}

	const mapping = mappings.get(objectKey(sourceType, name));
	const target = referencedName.toLowerCase();

	return mapping !== undefined && packageNames.has(target) && target !== name.toLowerCase() ? `${mapping.path}\u0000${target}` : null;
};

/**
 * Reads internal package dependencies from exported USER_DEPENDENCIES rows.
 *
 * Oracle records a dependency for every referenced package, including packages
 * the compiler infers from the expanded definition of a used type. A static
 * adapter that reads authored source cannot recover such an edge when the
 * target package never appears in that source. Under contract `oracle-o1@4`,
 * a truth edge whose authored file does not mention the target package as a
 * whole identifier is omitted as `compiler_inferred_dependency`.
 *
 * The check is deliberately conservative: any whole-identifier mention,
 * including one inside a comment or string literal, keeps the edge in the
 * denominator. An authored edge therefore can never be excluded, while the
 * recall gate measures only edges the source can name.
 *
 * @param rows - CSV rows.
 * @param mappings - Indexed object mappings.
 * @param packageNames - Package names present in the qualification corpus.
 * @param options - Authored source accessor.
 * @returns Included edges, omitted edges, and their counted reasons.
 */
export const readTruthDependencies = (
	rows: readonly (readonly string[])[],
	mappings: ReadonlyMap<string, ObjectMappingType>,
	packageNames: ReadonlySet<string>,
	options: ReadTruthDependenciesOptionsType,
): TruthDependenciesType => {
	const candidates = new Set<string>();

	for (const row of rows) {
		const candidate = candidateEdgeOf(row, mappings, packageNames);

		if (candidate !== null) {
			candidates.add(candidate);
		}
	}

	const sourceByPath = new Map<string, string>();
	const edges = new Set<string>();
	const excluded: ExcludedDependencyType[] = [];
	const excludedByReason = emptyDependencyExclusionCounts();

	for (const candidate of candidates) {
		const [sourcePath = '', target = ''] = candidate.split('\u0000');
		let source = sourceByPath.get(sourcePath);

		if (source === undefined) {
			source = options.sourceOf(sourcePath);
			sourceByPath.set(sourcePath, source);
		}

		if (mentionsIdentifier(source, target)) {
			edges.add(candidate);
			continue;
		}

		excluded.push({path: sourcePath, target, reason: 'compiler_inferred_dependency'});
		excludedByReason.compiler_inferred_dependency += 1;
	}

	return {edges, rawEdges: candidates.size, excluded, excludedByReason};
};
