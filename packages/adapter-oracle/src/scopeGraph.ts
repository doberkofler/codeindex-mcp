import {type OracleDeclarationType, type OracleParseResultType} from './syntax.ts';

export type OracleFileGraphType = Readonly<{
	canonicals: readonly string[];
	signatures: readonly string[];
	childrenByParent: ReadonlyMap<number, readonly number[]>;
}>;

export type OracleMemberLookupType = Readonly<{
	canonical: string;
	simpleName: string;
	kind: string;
	symbolId: string;
	path: string;
	declarationIndex: number;
	declaration: OracleDeclarationType;
	signature: string;
}>;

type OraclePackageLookupType = Readonly<{
	canonical: string;
	packageSymbolId: string;
	specPath: string | null;
	bodyPath: string | null;
	members: readonly OracleMemberLookupType[];
}>;

export type OraclePackageLookupMapType = ReadonlyMap<string, OraclePackageLookupType>;

/**
 * Returns the canonical unit identity for one declaration.
 *
 * @param parse - Parsed file.
 * @param declaration - Declaration that names its unit.
 * @returns The canonical `SCHEMA.OBJECT` identity.
 */
const unitCanonicalOf = (parse: OracleParseResultType, declaration: OracleDeclarationType): string =>
	parse.units[declaration.unit]?.canonical ?? declaration.name.canonical;

/**
 * Computes canonical declaration names along the nesting chain.
 *
 * @param parse - Parsed file.
 * @param index - Declaration index.
 * @param memo - Per-file memoized canonical names.
 * @returns The canonical declaration identity.
 */
const canonicalDeclarationName = (parse: OracleParseResultType, index: number, memo: string[] = []): string => {
	const existing = memo[index];

	if (existing !== undefined) {
		return existing;
	}

	const declaration = parse.declarations[index];

	if (declaration === undefined) {
		return '';
	}

	const canonical =
		declaration.parent === null
			? unitCanonicalOf(parse, declaration)
			: `${canonicalDeclarationName(parse, declaration.parent, memo)}.${declaration.name.canonical}`;

	memo[index] = canonical;
	return canonical;
};

/**
 * Builds the normalized callable signature used to match specifications to bodies.
 *
 * @param parse - Parsed file.
 * @param index - Routine declaration index.
 * @param canonicals - Memoized canonical declaration names.
 * @returns A stable signature, or an empty string for non-routines.
 */
const callableSignature = (parse: OracleParseResultType, index: number, canonicals: readonly string[]): string => {
	const declaration = parse.declarations[index];

	if (declaration === undefined || (declaration.kind !== 'procedure' && declaration.kind !== 'function')) {
		return '';
	}

	const parameters = declaration.parameters.map((parameter) => `${parameter.mode}:${parameter.typeText}`).join(';');

	return `${declaration.kind}:${canonicals[index] ?? declaration.name.canonical}(${parameters})`;
};

/**
 * Builds per-file name and nesting indexes.
 *
 * @param parse - Parsed file.
 * @returns Canonical names, routine signatures, and direct children.
 */
export const buildFileGraph = (parse: OracleParseResultType): OracleFileGraphType => {
	const canonicals: string[] = [];

	for (let index = 0; index < parse.declarations.length; index += 1) {
		canonicalDeclarationName(parse, index, canonicals);
	}

	const signatures = parse.declarations.map((_declaration, index) => callableSignature(parse, index, canonicals));
	const children = new Map<number, number[]>();

	for (const [index, declaration] of parse.declarations.entries()) {
		if (declaration.parent === null) {
			continue;
		}

		const group = children.get(declaration.parent) ?? [];

		group.push(index);
		children.set(declaration.parent, group);
	}

	return {canonicals, signatures, childrenByParent: children};
};
