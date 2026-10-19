import {objectKey, type ObjectMappingType} from './oracleMapping.ts';

/**
 * Reads internal package dependencies from exported USER_DEPENDENCIES rows.
 *
 * @param rows - CSV rows.
 * @param mappings - Indexed object mappings.
 * @param packageNames - Package names present in the qualification corpus.
 * @returns Deduplicated source-path/target-package edges.
 */
export const readTruthDependencies = (
	rows: readonly (readonly string[])[],
	mappings: ReadonlyMap<string, ObjectMappingType>,
	packageNames: ReadonlySet<string>,
): ReadonlySet<string> => {
	const dependencies = new Set<string>();

	for (const row of rows) {
		if (row.length < 6) {
			continue;
		}

		const [name = '', sourceType = '', , referencedName = '', referencedType = ''] = row;

		if (referencedType.toUpperCase() !== 'PACKAGE') {
			continue;
		}

		const mapping = mappings.get(objectKey(sourceType, name));
		const target = referencedName.toLowerCase();

		if (mapping !== undefined && packageNames.has(target) && target !== name.toLowerCase()) {
			dependencies.add(`${mapping.path}\u0000${target}`);
		}
	}

	return dependencies;
};
