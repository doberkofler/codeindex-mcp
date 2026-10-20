import {type OracleFileGraphType} from './scopeGraph.ts';
import {type MutableBindingType, type OracleParsedFileType, type ParameterBindingType, type SpecPackageType, type SpecRoutineType} from './symbolTableTypes.ts';
import {type OracleDeclarationType} from './syntax.ts';

export type SpecMatchType = Readonly<{
	routine: SpecRoutineType | null;
	ambiguous: boolean;
}>;

const addToGroup = <ItemType>(group: Map<string, ItemType[]>, key: string, item: ItemType): void => {
	const existing = group.get(key) ?? [];

	existing.push(item);
	group.set(key, existing);
};

const parameterBindingsOf = (
	fileIndex: number,
	routineIndex: number,
	files: readonly OracleParsedFileType[],
	bindings: readonly MutableBindingType[][],
): readonly ParameterBindingType[] => {
	const file = files[fileIndex];

	if (file === undefined) {
		return [];
	}

	return file.parse.declarations.flatMap((declaration, index) =>
		declaration.parent === routineIndex && declaration.kind === 'parameter'
			? [{symbolId: bindings[fileIndex]?.[index]?.symbolId ?? '', canonical: bindings[fileIndex]?.[index]?.canonical ?? '', declaration}]
			: [],
	);
};

const addSpecRoutine = (
	input: Readonly<{
		fileIndex: number;
		child: number;
		declaration: OracleDeclarationType;
		binding: MutableBindingType;
		files: readonly OracleParsedFileType[];
		bindings: readonly MutableBindingType[][];
		routinesByHeading: Map<string, SpecRoutineType[]>;
	}>,
): void => {
	const routine: SpecRoutineType = {
		symbolId: input.binding.symbolId,
		fileIndex: input.fileIndex,
		declarationIndex: input.child,
		declaration: input.declaration,
		parameterBindings: parameterBindingsOf(input.fileIndex, input.child, input.files, input.bindings),
	};

	addToGroup(input.routinesByHeading, input.binding.heading, routine);
};

/**
 * Builds pairing-heading indexes for every package specification.
 *
 * @param files - Parsed files in one context.
 * @param graphs - Per-file canonical and nesting indexes.
 * @param bindings - Mutable declaration bindings.
 * @returns Specification packages keyed by canonical package name.
 */
export const buildSpecIndex = (
	files: readonly OracleParsedFileType[],
	graphs: readonly OracleFileGraphType[],
	bindings: readonly MutableBindingType[][],
): ReadonlyMap<string, SpecPackageType> => {
	const specs = new Map<string, SpecPackageType>();

	for (const [fileIndex, file] of files.entries()) {
		for (const unit of file.parse.units) {
			const graph = graphs[fileIndex];
			const binding = bindings[fileIndex]?.[unit.declaration];

			if (unit.kind !== 'package-spec' || graph === undefined || binding === undefined) {
				continue;
			}

			const routinesByHeading = new Map<string, SpecRoutineType[]>();

			for (const child of graph.childrenByParent.get(unit.declaration) ?? []) {
				const declaration = file.parse.declarations[child];
				const childBinding = bindings[fileIndex]?.[child];

				if (
					declaration === undefined ||
					childBinding === undefined ||
					(declaration.kind !== 'procedure' && declaration.kind !== 'function' && declaration.kind !== 'cursor')
				) {
					continue;
				}

				addSpecRoutine({
					fileIndex,
					child,
					declaration,
					binding: childBinding,
					files,
					bindings,
					routinesByHeading,
				});
			}

			specs.set(unit.canonical, {
				packageSymbolId: binding.symbolId,
				fileIndex,
				declarationIndex: unit.declaration,
				routinesByHeading,
			});
		}
	}

	return specs;
};

/**
 * Matches one body heading against a package specification.
 *
 * @param spec - Specification package.
 * @param heading - Normalized body heading.
 * @returns The unique match, or an ambiguous/missing result.
 */
export const matchSpecRoutine = (spec: SpecPackageType, heading: string): SpecMatchType => {
	const candidates = spec.routinesByHeading.get(heading) ?? [];

	if (candidates.length === 1) {
		return {routine: candidates[0] ?? null, ambiguous: false};
	}

	return {routine: null, ambiguous: candidates.length > 1};
};
