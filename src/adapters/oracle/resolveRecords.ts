import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {type OracleMemberLookupType} from './scopeGraph.ts';
import {type ChoiceCandidateType, type ResolutionType, type ResolveStateType} from './resolveReferences.ts';
import {type OracleDeclarationType, type OracleReferenceSiteType} from './syntax.ts';
import {declarationAt, type LocatedDeclarationType, type ResolutionServicesType} from './resolveTypes.ts';

const typeSymbolOf = (services: ResolutionServicesType, state: ResolveStateType, located: LocatedDeclarationType): string | null => {
	const [typeReference] = located.declaration.typeReferences;

	if (typeReference === undefined) {
		return null;
	}

	const targetState: ResolveStateType = located.file === state.file ? state : {...state, fileIndex: located.fileIndex, file: located.file};
	const site = services.syntheticSite(located.declaration, located.index);
	const [first] = typeReference.name.parts;

	return typeReference.name.parts.length === 1
		? services.resolveSimpleAt(targetState, located.index, first?.canonical ?? '', site).symbolId
		: services.resolveMember(targetState, typeReference.name.parts, site);
};

/**
 * Projects a package lookup entry onto one candidate.
 *
 * @param member - Package member lookup entry.
 * @returns The equivalent candidate.
 */
export const memberChoice = (member: OracleMemberLookupType): ChoiceCandidateType => ({
	symbolId: member.symbolId,
	kind: member.kind,
	declaration: member.declaration,
	path: member.path,
});

/**
 * Projects one local declaration onto one candidate.
 *
 * @param file - Owning file analysis.
 * @param index - Declaration index.
 * @param declaration - Declaration to project.
 * @returns The equivalent candidate.
 */
const localChoice = (file: OracleFileAnalysisType, index: number, declaration: OracleDeclarationType): ChoiceCandidateType => ({
	symbolId: file.bindings[index]?.symbolId ?? '',
	kind: declaration.kind,
	declaration,
	path: file.path,
});

/**
 * Lists direct children of one declaration by canonical name.
 *
 * @param file - Owning file analysis.
 * @param parent - Parent declaration index.
 * @param canonical - Canonical child name.
 * @returns Matching child candidates.
 */
export const directChildren = (file: OracleFileAnalysisType, parent: number, canonical: string): readonly ChoiceCandidateType[] =>
	(file.graph.childrenByParent.get(parent) ?? []).flatMap((index) => {
		const declaration = file.parse.declarations[index];

		return declaration?.name.canonical === canonical ? [localChoice(file, index, declaration)] : [];
	});

/**
 * Resolves one field of a record, collection, or aliased declaration.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param field - Owning declaration identifier and the field to resolve.
 * @param depth - Current alias depth.
 * @returns The field symbol identifier, or a no-field outcome.
 */
export const recordFieldResolution = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	field: Readonly<{symbolId: string; canonical: string}>,
	depth: number,
): ResolutionType => {
	if (depth > 8) {
		return {symbolId: null, outcome: 'no-field'};
	}

	const located = declarationAt(state, field.symbolId);

	if (located === null) {
		return {symbolId: null, outcome: 'no-field'};
	}

	if (located.declaration.kind === 'record_type' || located.declaration.kind === 'package') {
		const [child] = directChildren(located.file, located.index, field.canonical);

		return child === undefined ? {symbolId: null, outcome: 'no-field'} : {symbolId: child.symbolId, outcome: 'resolved'};
	}

	if (located.declaration.kind === 'collection_type') {
		const [child] = directChildren(located.file, located.index, field.canonical);

		if (child !== undefined) {
			return {symbolId: child.symbolId, outcome: 'resolved'};
		}
	}

	const typeSymbolId = typeSymbolOf(services, state, located);

	return typeSymbolId === null
		? {symbolId: null, outcome: 'no-field'}
		: recordFieldResolution(services, state, {symbolId: typeSymbolId, canonical: field.canonical}, depth + 1);
};

/**
 * Resolves a full member chain that starts at a value in scope.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param parts - Authored name parts.
 * @param site - Reference site that owns the chain.
 * @returns The final symbol identifier, or the failing stage.
 */
export const resolveRecordChain = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	parts: OracleReferenceSiteType['name']['parts'],
	site: OracleReferenceSiteType,
): ResolutionType => {
	const [first, ...rest] = parts;

	if (first === undefined) {
		return {symbolId: null, outcome: 'no-declaration'};
	}

	const base = services.resolveSimpleAt(state, site.enclosing, first.canonical, site);

	const {symbolId: baseSymbolId} = base;

	if (baseSymbolId === null) {
		return base;
	}

	let symbolId = baseSymbolId;

	for (const part of rest) {
		const field = recordFieldResolution(services, state, {symbolId, canonical: part.canonical}, 0);

		if (field.symbolId === null) {
			return field;
		}

		({symbolId} = field);
	}

	return {symbolId, outcome: 'resolved'};
};

const elementRecordOf = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	located: LocatedDeclarationType,
	depth: number,
): LocatedDeclarationType | null => {
	if (depth > 6) {
		return null;
	}

	if (located.declaration.kind === 'record_type') {
		return located;
	}

	const typeSymbolId = typeSymbolOf(services, state, located);
	const next = typeSymbolId === null ? null : declarationAt(state, typeSymbolId);

	return next === null ? null : elementRecordOf(services, state, next, depth + 1);
};

/**
 * Lists the record fields a `BULK COLLECT INTO` target assigns, in declaration order.
 *
 * The compiler fills the element record positionally, so the first `limit`
 * fields receive the selected items regardless of the selected column names.
 *
 * @param services - Injected name resolution callbacks.
 * @param state - Resolution state.
 * @param symbolId - Target collection, variable, or field identifier.
 * @param limit - Number of selected items, or null when every field is assigned.
 * @returns Field symbol identifiers in declaration order.
 */
export const bulkFieldSymbolsOf = (services: ResolutionServicesType, state: ResolveStateType, symbolId: string, limit: number | null): readonly string[] => {
	const located = declarationAt(state, symbolId);
	const record = located === null ? null : elementRecordOf(services, state, located, 0);

	if (record === null) {
		return [];
	}

	const indices = record.file.graph.childrenByParent.get(record.index) ?? [];
	const symbols = indices
		.filter((index) => record.file.parse.declarations[index]?.kind === 'field')
		.map((index) => record.file.bindings[index]?.symbolId ?? '')
		.filter((id) => id !== '');

	return limit === null ? symbols : symbols.slice(0, limit);
};
