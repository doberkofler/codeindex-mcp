import {oracleNameOf} from './name.ts';
import {type OracleDeclarationType, type OracleDependencySiteType, type OracleReferenceSiteType} from './syntax.ts';

type InputType = Readonly<{
	references: readonly OracleReferenceSiteType[];
	declarations: readonly OracleDeclarationType[];
	sqlNames: ReadonlySet<string>;
}>;

const dependencyKindOf = (kind: OracleReferenceSiteType['kind']): OracleDependencySiteType['kind'] =>
	kind === 'call' ? 'package-call' : kind === 'type-anchor' ? 'type-reference' : 'package-reference';

type ChildNameType = Readonly<{name: string; startOffset: number}>;

const childNamesOf = (declarations: readonly OracleDeclarationType[]): ReadonlyMap<number, readonly ChildNameType[]> => {
	const names = new Map<number, ChildNameType[]>();

	for (const declaration of declarations) {
		if (declaration.parent === null) {
			continue;
		}

		const group = names.get(declaration.parent) ?? [];

		group.push({name: declaration.name.canonical, startOffset: declaration.range.startOffset});
		names.set(declaration.parent, group);
	}

	return names;
};

type LocalNameInputType = Readonly<{
	declarations: readonly OracleDeclarationType[];
	childNames: ReadonlyMap<number, readonly ChildNameType[]>;
	enclosing: number;
	canonical: string;
	startOffset: number;
}>;

const isLocalName = (input: LocalNameInputType): boolean => {
	let current: number | null = input.enclosing;

	while (current !== null) {
		const children = input.childNames.get(current);

		if (children?.some((child) => child.name === input.canonical && child.startOffset <= input.startOffset) === true) {
			return true;
		}

		current = input.declarations[current]?.parent ?? null;
	}

	return false;
};

/**
 * Derives package dependency sites from resolved-name candidates.
 *
 * A qualified chain whose first segment is a local declaration is a record,
 * collection, cursor, or field chain, not a package target, and is excluded.
 * Non-call chains whose first segment is a SQL table, alias, column alias, or
 * query name are also excluded. Remaining qualified chains keep the structural
 * parser's target slicing so workspace packages and external package calls
 * resolve through the existing dependency extractor.
 *
 * @param input - Reference sites, declarations, and SQL qualifier names from one parse tree.
 * @returns Dependency sites with package calls, package references, and type references.
 */
export const collectAntlrDependencies = (input: InputType): readonly OracleDependencySiteType[] => {
	const childNames = childNamesOf(input.declarations);
	const dependencies: OracleDependencySiteType[] = [];

	for (const reference of input.references) {
		const [first] = reference.name.parts;

		if (reference.name.parts.length < 2 || first === undefined) {
			continue;
		}

		if (
			isLocalName({
				declarations: input.declarations,
				childNames,
				enclosing: reference.enclosing,
				canonical: first.canonical,
				startOffset: reference.range.startOffset,
			})
		) {
			continue;
		}

		if (reference.kind !== 'call' && input.sqlNames.has(first.canonical)) {
			continue;
		}

		const targetParts = reference.name.parts.length >= 3 ? reference.name.parts.slice(0, 2) : reference.name.parts.slice(0, 1);

		dependencies.push({
			targetName: oracleNameOf({parts: targetParts}),
			memberName: reference.name.parts.at(-1) ?? null,
			range: reference.range,
			unit: reference.unit,
			enclosing: reference.enclosing,
			kind: dependencyKindOf(reference.kind),
		});
	}

	return dependencies;
};
