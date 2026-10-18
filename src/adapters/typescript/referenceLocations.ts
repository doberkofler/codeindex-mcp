import path from 'node:path';

const {relative, isAbsolute} = path;

/**
 * One comparable occurrence of a symbol.
 *
 * Locations are normalized so the language service and the extractor can be
 * compared without relying on line numbers or declaration ordering.
 */
export type ReferenceLocationType = Readonly<{
	readonly path: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly role: 'definition' | 'reference';
}>;

export type ReferenceLocationComparisonType = Readonly<{
	readonly expected: readonly ReferenceLocationType[];
	readonly actual: readonly ReferenceLocationType[];
	readonly matched: readonly ReferenceLocationType[];
	readonly missing: readonly ReferenceLocationType[];
	readonly extra: readonly ReferenceLocationType[];
	readonly expectedCount: number;
	readonly actualCount: number;
	readonly matchedCount: number;
	readonly recall: number;
	readonly precision: number;
}>;

/**
 * Creates the identity of one occurrence.
 *
 * The role participates in the identity: a definition and a reference at the
 * same byte range are different facts and must never mask each other.
 *
 * @param location - Normalized occurrence.
 * @returns Stable comparison key.
 */
export const referenceLocationKey = (location: ReferenceLocationType): string =>
	`${location.path}\u0000${location.startOffset}\u0000${location.endOffset}\u0000${location.role}`;

const compareLocations = (left: ReferenceLocationType, right: ReferenceLocationType): number =>
	left.path.localeCompare(right.path) || left.startOffset - right.startOffset || left.endOffset - right.endOffset || left.role.localeCompare(right.role);

/**
 * Sorts and deduplicates occurrences deterministically.
 *
 * Duplicate facts can be reported by the language service when alias groups
 * overlap. They are collapsed before comparison so they cannot inflate recall.
 *
 * @param locations - Occurrences in any order.
 * @returns Unique occurrences sorted by path, range, and role.
 */
export const normalizeReferenceLocations = (locations: readonly ReferenceLocationType[]): readonly ReferenceLocationType[] => {
	const unique = new Map<string, ReferenceLocationType>();

	for (const location of locations) {
		unique.set(referenceLocationKey(location), location);
	}

	return [...unique.values()].sort(compareLocations);
};

/**
 * Converts an absolute compiler path into a workspace-relative POSIX path.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param fileName - Absolute compiler file name.
 * @returns Workspace-relative POSIX path, or null when the file escapes the root.
 */
export const toLocationPath = (rootDir: string, fileName: string): string | null => {
	const relativePath = relative(rootDir, fileName);

	if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
		return null;
	}

	return relativePath.split('\\').join('/');
};

/**
 * Keeps only occurrences inside the exact authored file set.
 *
 * Dependency declarations and compiler library files still participate in
 * resolution but are intentionally absent from the index, so they must not
 * reduce recall.
 *
 * @param locations - Normalized occurrences.
 * @param authoredPaths - Workspace-relative authored paths.
 * @returns Occurrences inside the authored set.
 */
export const filterAuthoredLocations = (locations: readonly ReferenceLocationType[], authoredPaths: ReadonlySet<string>): readonly ReferenceLocationType[] =>
	locations.filter((location) => authoredPaths.has(location.path));

/**
 * Compares expected and actual occurrences using exact range and role identity.
 *
 * An empty expected set is never considered a successful comparison.
 *
 * @param expectedLocations - Language-service occurrences.
 * @param actualLocations - Extractor occurrences.
 * @returns Matched, missing, and extra occurrences with micro recall and precision.
 */
export const compareReferenceLocations = (
	expectedLocations: readonly ReferenceLocationType[],
	actualLocations: readonly ReferenceLocationType[],
): ReferenceLocationComparisonType => {
	const expected = normalizeReferenceLocations(expectedLocations);
	const actual = normalizeReferenceLocations(actualLocations);
	const actualKeys = new Set(actual.map((location) => referenceLocationKey(location)));
	const expectedKeys = new Set(expected.map((location) => referenceLocationKey(location)));
	const matched = expected.filter((location) => actualKeys.has(referenceLocationKey(location)));
	const missing = expected.filter((location) => !actualKeys.has(referenceLocationKey(location)));
	const extra = actual.filter((location) => !expectedKeys.has(referenceLocationKey(location)));

	return {
		expected,
		actual,
		matched,
		missing,
		extra,
		expectedCount: expected.length,
		actualCount: actual.length,
		matchedCount: matched.length,
		recall: expected.length === 0 ? 0 : matched.length / expected.length,
		precision: actual.length === 0 ? 0 : matched.length / actual.length,
	};
};
