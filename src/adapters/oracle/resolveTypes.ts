import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {type ChoiceCandidateType, type ResolutionType, type ResolveStateType} from './resolveReferences.ts';
import {type OracleDeclarationType, type OracleReferenceSiteType} from './syntax.ts';

/**
 * Name resolution callbacks the type layer needs.
 *
 * They are injected so that type inference never depends on the scope resolver
 * module and cannot create an import cycle.
 */
export type ResolutionServicesType = Readonly<{
	resolveSimpleAt: (state: ResolveStateType, startDeclaration: number, canonical: string, site: OracleReferenceSiteType) => ResolutionType;
	resolveMember: (state: ResolveStateType, parts: OracleReferenceSiteType['name']['parts'], site: OracleReferenceSiteType) => string | null;
	resolveSite: (state: ResolveStateType, site: OracleReferenceSiteType) => ResolutionType;
	syntheticSite: (declaration: OracleDeclarationType, declarationIndex: number) => OracleReferenceSiteType;
}>;

/** One declaration resolved in its owning file, used for type resolution. */
export type LocatedDeclarationType = Readonly<{declaration: OracleDeclarationType; file: OracleFileAnalysisType; fileIndex: number; index: number}>;

/** Either form of a declaration target: an identifier or a located declaration. */
type TypeSourceType = Readonly<{symbolId: string}> | Readonly<{located: LocatedDeclarationType}>;

const TYPE_EQUIVALENTS: Readonly<Record<string, string>> = {
	VARCHAR: 'VARCHAR2',
	NVARCHAR: 'NVARCHAR2',
	DECIMAL: 'NUMBER',
	NUMERIC: 'NUMBER',
	INT: 'INTEGER',
	SMALLINT: 'INTEGER',
};

const NUMERIC_FAMILY = new Set([
	'NUMBER',
	'PLS_INTEGER',
	'SIMPLE_INTEGER',
	'BINARY_INTEGER',
	'INTEGER',
	'INT',
	'SMALLINT',
	'DECIMAL',
	'NUMERIC',
	'FLOAT',
	'REAL',
	'BINARY_FLOAT',
	'BINARY_DOUBLE',
	'NATURAL',
	'NATURALN',
	'POSITIVE',
	'POSITIVEN',
]);

const CHARACTER_FAMILY = new Set(['VARCHAR2', 'VARCHAR', 'CHAR', 'NCHAR', 'NVARCHAR2', 'CLOB', 'NCLOB', 'LONG']);

/** Oracle JSON types are one inheritance chain rooted at `JSON_ELEMENT_T`. */
const JSON_PARENTS: Readonly<Record<string, string>> = {
	JSON_OBJECT_T: 'JSON_ELEMENT_T',
	JSON_ARRAY_T: 'JSON_ELEMENT_T',
};

const canonicalType = (canonical: string): string => TYPE_EQUIVALENTS[canonical] ?? canonical;

const familyOf = (canonical: string): string | null => {
	if (NUMERIC_FAMILY.has(canonical)) {
		return 'numeric';
	}

	return CHARACTER_FAMILY.has(canonical) ? 'character' : null;
};

/**
 * Reports whether one argument type can bind one parameter type.
 *
 * @param argument - Argument type identity.
 * @param expected - Parameter type identity.
 * @param exact - Whether only exact spelling and known inheritance may match.
 * @returns Whether the argument is compatible with the parameter.
 */
const typesCompatible = (argument: string, expected: string, exact: boolean): boolean => {
	if (argument === expected || JSON_PARENTS[argument] === expected) {
		return true;
	}

	if (exact) {
		return false;
	}

	const family = familyOf(argument);

	return family !== null && family === familyOf(expected);
};

/**
 * Locates the declaration a symbol identifier belongs to.
 *
 * @param state - Resolution state.
 * @param symbolId - Symbol identifier.
 * @returns The declaration and its file, or null when unresolved.
 */
export const declarationAt = (state: ResolveStateType, symbolId: string): LocatedDeclarationType | null => {
	const location = state.symbolDeclarations.get(symbolId);

	if (location === undefined) {
		return null;
	}

	const file = state.input.files[location.fileIndex];
	const declaration = file?.parse.declarations[location.declarationIndex];

	return file === undefined || declaration === undefined ? null : {declaration, file, fileIndex: location.fileIndex, index: location.declarationIndex};
};

/**
 * Resolves the scalar identity a declaration was declared with.
 *
 * Subtype aliases are followed so that `SUBTYPE money IS NUMBER` compares as
 * `NUMBER`; anchors such as `%TYPE` stay unknown because the anchor's type is
 * not in the corpus.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param source - Symbol identifier or located declaration.
 * @param depth - Current alias depth.
 * @returns The canonical type identity, or null when it is unknown.
 */
type TypeTargetType = Readonly<{
	state: ResolveStateType;
	reference: NonNullable<OracleDeclarationType['typeReferences']>[number];
	canonical: string;
	resolved: string | null;
}>;

const typeTargetOf = (services: ResolutionServicesType, state: ResolveStateType, located: LocatedDeclarationType): TypeTargetType | null => {
	const [reference] = located.declaration.typeReferences;

	if (reference === undefined || reference.anchored || reference.rowType) {
		return null;
	}

	const canonical = reference.name.parts.at(-1)?.canonical ?? '';

	if (canonical === '') {
		return null;
	}

	const targetState: ResolveStateType = located.file === state.file ? state : {...state, fileIndex: located.fileIndex, file: located.file};
	const site = services.syntheticSite(located.declaration, located.index);
	const [first] = reference.name.parts;
	const resolved =
		reference.name.parts.length === 1
			? services.resolveSimpleAt(targetState, located.index, first?.canonical ?? '', site).symbolId
			: services.resolveMember(targetState, reference.name.parts, site);

	return {state: targetState, reference, canonical, resolved};
};

/**
 * Resolves the scalar identity a declaration was declared with.
 *
 * Subtype aliases are followed so that `SUBTYPE money IS NUMBER` compares as
 * `NUMBER`; anchors such as `%TYPE` stay unknown because the anchor's type is
 * not in the corpus.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param source - Symbol identifier or located declaration.
 * @param depth - Current alias depth.
 * @returns The canonical type identity, or null when it is unknown.
 */
const typeIdentityOf = (services: ResolutionServicesType, state: ResolveStateType, source: TypeSourceType, depth: number): string | null => {
	if (depth > 4) {
		return null;
	}

	const located = 'located' in source ? source.located : declarationAt(state, source.symbolId);
	const target = located === null ? null : typeTargetOf(services, state, located);

	if (target === null) {
		return null;
	}

	if (target.resolved === null) {
		return canonicalType(target.canonical);
	}

	const declaration = declarationAt(target.state, target.resolved);

	if (declaration?.declaration.kind === 'subtype') {
		return typeIdentityOf(services, target.state, {located: declaration}, depth + 1);
	}

	return declaration === null ? canonicalType(target.canonical) : canonicalType(declaration.declaration.name.canonical);
};

/**
 * Resolves the element type identity of a declaration whose type is a collection.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param symbolId - Collection declaration identifier.
 * @param depth - Current alias depth.
 * @returns The element type identity, or null when it is unknown.
 */
const collectionElementTypeOf = (services: ResolutionServicesType, state: ResolveStateType, symbolId: string, depth: number): string | null => {
	if (depth > 4) {
		return null;
	}

	const located = declarationAt(state, symbolId);
	const target = located === null ? null : typeTargetOf(services, state, located);

	const resolved = target?.resolved ?? null;

	if (target === null || resolved === null) {
		return null;
	}

	const declaration = declarationAt(target.state, resolved);

	if (declaration?.declaration.kind === 'subtype') {
		return collectionElementTypeOf(services, target.state, resolved, depth + 1);
	}

	return declaration?.declaration.kind === 'collection_type' ? typeIdentityOf(services, target.state, {located: declaration}, depth + 1) : null;
};

/**
 * Resolves the static type of one call argument.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param site - Call site that owns the argument.
 * @param argument - Argument shape read by the parser.
 * @returns The canonical type identity, or null when it is unknown.
 */
const argumentTypeOf = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	site: OracleReferenceSiteType,
	argument: NonNullable<OracleReferenceSiteType['arguments']>[number],
): string | null => {
	if (argument.literalType !== undefined) {
		return canonicalType(argument.literalType);
	}

	const lead = argument.leadName;

	if (lead === undefined) {
		return null;
	}

	const argumentSite: OracleReferenceSiteType = {
		name: lead,
		range: argument.range,
		nameRange: argument.range,
		unit: site.unit,
		enclosing: site.enclosing,
		kind: 'reference',
		argumentCount: null,
		argumentNames: [],
		rowType: false,
	};
	const resolution = services.resolveSite(state, argumentSite);

	if (resolution.symbolId === null) {
		return null;
	}

	const identity = typeIdentityOf(services, state, {symbolId: resolution.symbolId}, 1);

	if (argument.indexed !== true || identity === null) {
		return identity;
	}

	// `collection(index)` has the type of the collection's element.
	return collectionElementTypeOf(services, state, resolution.symbolId, 0) ?? identity;
};

type ParameterMatchType = Readonly<{
	parameter: OracleDeclarationType['parameters'][number];
	argument: NonNullable<OracleReferenceSiteType['arguments']>[number];
}>;

const parameterMatchesOf = (candidate: ChoiceCandidateType, site: OracleReferenceSiteType): readonly ParameterMatchType[] => {
	const {parameters} = candidate.declaration;
	const args = site.arguments;

	if (args === undefined || args.length === 0) {
		return [];
	}

	if (site.argumentNames.length === 0) {
		return args.flatMap((argument, position) => {
			const parameter = parameters[position];
			return parameter === undefined ? [] : [{parameter, argument}];
		});
	}

	const byName = new Map(parameters.map((parameter) => [parameter.name.canonical, parameter]));
	const used = new Set<string>();
	const matches: ParameterMatchType[] = [];
	let position = 0;

	for (const argument of args) {
		const named = argument.name === null ? undefined : byName.get(argument.name);

		if (named !== undefined) {
			used.add(named.name.canonical);
			matches.push({parameter: named, argument});
			continue;
		}

		while (position < parameters.length && used.has(parameters[position]?.name.canonical ?? '')) {
			position += 1;
		}

		const parameter = parameters[position];

		if (parameter !== undefined) {
			used.add(parameter.name.canonical);
			matches.push({parameter, argument});
		}
	}

	return matches;
};

/**
 * Resolves the declared type identity of one candidate parameter.
 *
 * Only aliases are expanded here: a built-in name that shares a spelling with
 * an unrelated declaration must keep its written identity.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param candidate - Callable candidate that owns the parameter.
 * @param reference - Parameter type reference.
 * @returns The canonical parameter type identity.
 */
const parameterTypeIdentityOf = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	candidate: ChoiceCandidateType,
	reference: NonNullable<OracleDeclarationType['typeReferences']>[number],
): string => {
	const canonical = canonicalType(reference.name.parts.at(-1)?.canonical ?? '');
	const location = state.symbolDeclarations.get(candidate.symbolId);

	if (location === undefined) {
		return canonical;
	}

	const file = state.input.files[location.fileIndex];

	if (file === undefined) {
		return canonical;
	}

	const targetState: ResolveStateType = file === state.file ? state : {...state, fileIndex: location.fileIndex, file};
	const site = services.syntheticSite(candidate.declaration, location.declarationIndex);
	const [first] = reference.name.parts;
	const resolved =
		reference.name.parts.length === 1
			? services.resolveSimpleAt(targetState, location.declarationIndex, first?.canonical ?? '', site).symbolId
			: services.resolveMember(targetState, reference.name.parts, site);

	const target = resolved === null ? null : declarationAt(targetState, resolved);

	return target?.declaration.kind === 'subtype' ? (typeIdentityOf(services, targetState, {located: target}, 0) ?? canonical) : canonical;
};

/**
 * Narrows callable candidates by the static types of their arguments.
 *
 * A parameter whose direction is `OUT` receives no value, so it never
 * discriminates. When no candidate accepts every known argument type the
 * filter is abandoned: an unknown or mismatched static type must not turn a
 * valid call into an arbitrary choice.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param candidates - Callable candidates that already fit by arity.
 * @param input - Call site and whether only exact type matches may qualify.
 * @returns Candidates whose parameter types accept every known argument type.
 */
export const filterByTypes = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	candidates: readonly ChoiceCandidateType[],
	input: Readonly<{site: OracleReferenceSiteType; exact: boolean}>,
): readonly ChoiceCandidateType[] =>
	candidates.filter((candidate) => {
		for (const {parameter, argument} of parameterMatchesOf(candidate, input.site)) {
			if (parameter.mode === 'OUT') {
				continue;
			}

			const argumentType = argumentTypeOf(services, state, input.site, argument);
			const parameterType = parameter.typeReferences.at(0);

			if (argumentType === null || parameterType === undefined || parameterType.anchored || parameterType.rowType) {
				continue;
			}

			const expected = parameterTypeIdentityOf(services, state, candidate, parameterType);

			if (expected !== '' && !typesCompatible(argumentType, expected, input.exact)) {
				return false;
			}
		}

		return true;
	});
