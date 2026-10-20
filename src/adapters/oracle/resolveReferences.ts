import {type DiagnosticType, type IndexedOccurrenceType} from '../../core/model.ts';
import {isStoredOracleDeclaration} from './declarationStorage.ts';
import {ORACLE_DIAGNOSTIC, OracleDiagnosticCollector} from './diagnostics.ts';
import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {outArgumentRangesOf, refineOutArgumentUsage, type OutArgumentRangeType} from './referenceOutArguments.ts';
import {type OracleMemberLookupType, type OraclePackageLookupMapType} from './scopeGraph.ts';
import {type OracleDeclarationType, type OracleReferenceSiteType} from './syntax.ts';

type ResolvedDeclarationType = Readonly<{fileIndex: number; declarationIndex: number}>;

type ChoiceCandidateType = Readonly<{
	symbolId: string;
	kind: string;
	declaration: OracleDeclarationType;
	path: string;
}>;

type ResolveInputType = Readonly<{
	context: string;
	defaultSchema: string;
	files: readonly OracleFileAnalysisType[];
	packages: OraclePackageLookupMapType;
	/** Drop occurrences whose target is not a stored declaration class. */
	storedOnly?: boolean | undefined;
}>;

type ResolveStateType = Readonly<{
	input: ResolveInputType;
	fileIndex: number;
	file: OracleFileAnalysisType;
	symbolDeclarations: ReadonlyMap<string, ResolvedDeclarationType>;
	diagnostics: OracleDiagnosticCollector;
}>;

export type OracleResolvedReferencesType = Readonly<{
	occurrences: readonly IndexedOccurrenceType[];
	diagnostics: readonly DiagnosticType[];
}>;

const buildSymbolDeclarations = (files: readonly OracleFileAnalysisType[]): ReadonlyMap<string, ResolvedDeclarationType> => {
	const map = new Map<string, ResolvedDeclarationType>();

	for (const [fileIndex, file] of files.entries()) {
		for (const [declarationIndex, binding] of file.bindings.entries()) {
			if (binding.symbolId !== '') {
				map.set(binding.symbolId, {fileIndex, declarationIndex});
			}
		}
	}

	return map;
};

const memberChoice = (member: OracleMemberLookupType): ChoiceCandidateType => ({
	symbolId: member.symbolId,
	kind: member.kind,
	declaration: member.declaration,
	path: member.path,
});

const localChoice = (file: OracleFileAnalysisType, index: number, declaration: OracleDeclarationType): ChoiceCandidateType => ({
	symbolId: file.bindings[index]?.symbolId ?? '',
	kind: declaration.kind,
	declaration,
	path: file.path,
});

const fitsArguments = (candidate: ChoiceCandidateType, site: OracleReferenceSiteType): boolean => {
	const {parameters} = candidate.declaration;
	const provided = site.argumentCount ?? 0;
	const required = parameters.filter((parameter) => !parameter.hasDefault).length;

	if (provided < required || provided > parameters.length) {
		return false;
	}

	if (site.argumentNames.length === 0) {
		return true;
	}

	const names = new Set(parameters.map((parameter) => parameter.name.canonical));
	return site.argumentNames.every((name) => names.has(name));
};

const nonRoutineCandidates = (candidates: readonly ChoiceCandidateType[]): readonly ChoiceCandidateType[] =>
	candidates.filter((candidate) => candidate.kind !== 'procedure' && candidate.kind !== 'function');

const nearestNonRoutine = (candidates: readonly ChoiceCandidateType[], site: OracleReferenceSiteType, state: ResolveStateType): ChoiceCandidateType | null => {
	const nonRoutines = nonRoutineCandidates(candidates);

	if (nonRoutines.length <= 1) {
		return nonRoutines[0] ?? null;
	}

	const sameFile = nonRoutines.filter((candidate) => candidate.path === state.file.path && candidate.declaration.range.startOffset <= site.range.startOffset);

	if (sameFile.length > 0) {
		return [...sameFile].sort((left, right) => right.declaration.range.startOffset - left.declaration.range.startOffset)[0] ?? null;
	}

	return (
		[...nonRoutines].sort(
			(left, right) => left.path.localeCompare(right.path) || left.declaration.range.startOffset - right.declaration.range.startOffset,
		)[0] ?? null
	);
};

const chooseCandidate = (
	candidates: readonly ChoiceCandidateType[],
	site: OracleReferenceSiteType,
	state: ResolveStateType,
	reportAmbiguity: boolean,
): ChoiceCandidateType | null => {
	const valid = candidates.filter((candidate) => candidate.symbolId !== '');

	if (valid.length <= 1) {
		return valid[0] ?? null;
	}

	if (site.kind === 'call') {
		const fitting = valid.filter((candidate) => (candidate.kind === 'procedure' || candidate.kind === 'function' ? fitsArguments(candidate, site) : false));

		if (fitting.length === 1) {
			return fitting[0] ?? null;
		}

		if (fitting.length > 1) {
			if (reportAmbiguity) {
				state.diagnostics.add(ORACLE_DIAGNOSTIC.ambiguousOverload, `Ambiguous overload for ${site.name.text}`, site.range.startLine, site.range.startColumn);
			}

			return null;
		}

		// A call-shaped site can be collection or record indexing rather than a
		// routine call. Fall back to a non-routine only when no callable fits.
		return nearestNonRoutine(valid, site, state);
	}

	return nearestNonRoutine(valid, site, state);
};

const directChildren = (file: OracleFileAnalysisType, parent: number, canonical: string): readonly ChoiceCandidateType[] =>
	(file.graph.childrenByParent.get(parent) ?? []).flatMap((index) => {
		const declaration = file.parse.declarations[index];

		return declaration?.name.canonical === canonical ? [localChoice(file, index, declaration)] : [];
	});

const packageOfDeclaration = (file: OracleFileAnalysisType, declarationIndex: number): string | null => {
	const declaration = file.parse.declarations[declarationIndex];

	if (declaration === undefined) {
		return null;
	}

	const unit = file.parse.units[declaration.unit];

	return unit?.kind === 'package-spec' || unit?.kind === 'package-body' ? unit.canonical : null;
};

const packageMembers = (state: ResolveStateType, packageCanonical: string | null, canonical: string): readonly ChoiceCandidateType[] => {
	if (packageCanonical === null) {
		return [];
	}

	const packageRecord = state.input.packages.get(packageCanonical);

	return (packageRecord?.members ?? []).filter((member) => member.simpleName === canonical).map((member) => memberChoice(member));
};

const resolveSimpleAt = (state: ResolveStateType, startDeclaration: number, canonical: string, site: OracleReferenceSiteType): string | null => {
	let current: number | null = startDeclaration;

	while (current !== null) {
		const candidates = directChildren(state.file, current, canonical);

		if (candidates.length > 0) {
			return chooseCandidate(candidates, site, state, true)?.symbolId ?? null;
		}

		current = state.file.parse.declarations[current]?.parent ?? null;
	}

	const declaration = state.file.parse.declarations[startDeclaration];
	const packageCanonical = declaration === undefined ? null : packageOfDeclaration(state.file, startDeclaration);

	return chooseCandidate(packageMembers(state, packageCanonical, canonical), site, state, true)?.symbolId ?? null;
};

const syntheticSite = (declaration: OracleDeclarationType, declarationIndex: number): OracleReferenceSiteType => ({
	name: {parts: [], text: declaration.name.text, canonical: declaration.name.canonical},
	range: declaration.nameRange,
	nameRange: declaration.nameRange,
	unit: declaration.unit,
	enclosing: declarationIndex,
	kind: 'reference',
	argumentCount: null,
	argumentNames: [],
	rowType: false,
});

const packageMemberResolver: {
	current: ((state: ResolveStateType, parts: OracleReferenceSiteType['name']['parts'], site: OracleReferenceSiteType) => string | null) | null;
} = {current: null};

const typeSymbolOf = (state: ResolveStateType, location: ResolvedDeclarationType, declaration: OracleDeclarationType): string | null => {
	const [typeReference] = declaration.typeReferences;

	if (typeReference === undefined) {
		return null;
	}

	const file = state.input.files[location.fileIndex];

	if (file === undefined) {
		return null;
	}

	const targetState: ResolveStateType = file === state.file ? state : {...state, fileIndex: location.fileIndex, file};
	const site = syntheticSite(declaration, location.declarationIndex);
	const [first] = typeReference.name.parts;

	return typeReference.name.parts.length === 1
		? resolveSimpleAt(targetState, location.declarationIndex, first?.canonical ?? '', site)
		: (packageMemberResolver.current?.(targetState, typeReference.name.parts, site) ?? null);
};

const recordField = (state: ResolveStateType, symbolId: string, canonical: string, depth: number): string | null => {
	if (depth > 8) {
		return null;
	}

	const location = state.symbolDeclarations.get(symbolId);

	if (location === undefined) {
		return null;
	}

	const file = state.input.files[location.fileIndex];
	const declaration = file?.parse.declarations[location.declarationIndex];

	if (file === undefined || declaration === undefined) {
		return null;
	}

	if (declaration.kind === 'record_type' || declaration.kind === 'package') {
		const [child] = directChildren(file, location.declarationIndex, canonical);
		return child?.symbolId ?? null;
	}

	if (declaration.kind === 'collection_type') {
		const [child] = directChildren(file, location.declarationIndex, canonical);

		if (child !== undefined) {
			return child.symbolId;
		}
	}

	const typeSymbolId = typeSymbolOf(state, location, declaration);

	return typeSymbolId === null ? null : recordField(state, typeSymbolId, canonical, depth + 1);
};

const resolveRecordChain = (state: ResolveStateType, parts: OracleReferenceSiteType['name']['parts'], site: OracleReferenceSiteType): string | null => {
	const [first] = parts;

	if (first === undefined) {
		return null;
	}

	let symbolId = resolveSimpleAt(state, site.enclosing, first.canonical, site);

	if (symbolId === null) {
		return null;
	}

	for (const part of parts.slice(1)) {
		const field = recordField(state, symbolId, part.canonical, 0);

		if (field === null) {
			return null;
		}

		symbolId = field;
	}

	return symbolId;
};

const packageCanonicalOf = (parts: OracleReferenceSiteType['name']['parts'], defaultSchema: string, packagePartCount: number): string =>
	packagePartCount === 1
		? `${defaultSchema}.${parts[0]?.canonical ?? ''}`
		: parts
				.slice(0, 2)
				.map((part) => part.canonical)
				.join('.');

const resolvePackagePath = (
	state: ResolveStateType,
	parts: OracleReferenceSiteType['name']['parts'],
	site: OracleReferenceSiteType,
	packagePartCount: number,
): string | null => {
	const packageCanonical = packageCanonicalOf(parts, state.input.defaultSchema, packagePartCount);
	const member = parts[packagePartCount];

	if (member === undefined || state.input.packages.get(packageCanonical) === undefined) {
		return null;
	}

	const selected = chooseCandidate(packageMembers(state, packageCanonical, member.canonical), site, state, true);

	if (selected === null) {
		return null;
	}

	let {symbolId} = selected;

	for (const part of parts.slice(packagePartCount + 1)) {
		const field = recordField(state, symbolId, part.canonical, 0);

		if (field === null) {
			return null;
		}

		symbolId = field;
	}

	return symbolId;
};

const resolvePackageMember = (state: ResolveStateType, parts: OracleReferenceSiteType['name']['parts'], site: OracleReferenceSiteType): string | null => {
	const primary = parts.length >= 3 ? 2 : 1;
	const counts = primary === 2 && parts.length === 3 ? [2, 1] : [primary];

	for (const count of counts) {
		const symbolId = resolvePackagePath(state, parts, site, count);

		if (symbolId !== null) {
			return symbolId;
		}
	}

	return null;
};

packageMemberResolver.current = resolvePackageMember;

const resolveSite = (state: ResolveStateType, site: OracleReferenceSiteType): string | null => {
	const [first] = site.name.parts;

	if (site.name.parts.length === 1) {
		return resolveSimpleAt(state, site.enclosing, first?.canonical ?? '', site);
	}

	return resolveRecordChain(state, site.name.parts, site) ?? resolvePackageMember(state, site.name.parts, site);
};

const contextOf = (context: string): readonly string[] => [context];

const storedOwnerOf = (file: OracleFileAnalysisType, start: number): string | null => {
	let current: number | null = start;

	while (current !== null) {
		const declaration: OracleDeclarationType | undefined = file.parse.declarations[current];
		const binding = file.bindings[current];

		if (declaration === undefined) {
			return null;
		}

		if (binding !== undefined && binding.symbolId !== '' && isStoredOracleDeclaration(file.parse, declaration)) {
			return binding.symbolId;
		}

		current = declaration.parent;
	}

	return null;
};

const usageOfSite = (site: OracleReferenceSiteType): number => site.usage ?? (site.kind === 'call' ? 1 : site.kind === 'type-anchor' ? 8 : 2);

const occurrenceOf = (
	input: Readonly<{context: string; path: string; site: OracleReferenceSiteType; symbolId: string; enclosingId: string | null}>,
): IndexedOccurrenceType => ({
	symbolId: input.symbolId,
	path: input.path,
	startLine: input.site.nameRange.startLine,
	startColumn: input.site.nameRange.startColumn,
	endLine: input.site.nameRange.endLine,
	endColumn: input.site.nameRange.endColumn,
	startOffset: input.site.nameRange.startOffset,
	endOffset: input.site.nameRange.endOffset,
	role: 'reference',
	usage: usageOfSite(input.site),
	enclosingId: input.enclosingId,
	contexts: contextOf(input.context),
});

const isStoredTarget = (
	symbolId: string,
	symbolDeclarations: ReadonlyMap<string, ResolvedDeclarationType>,
	files: readonly OracleFileAnalysisType[],
): boolean => {
	const location = symbolDeclarations.get(symbolId);
	const file = location === undefined ? undefined : files[location.fileIndex];
	const declaration = location === undefined || file === undefined ? undefined : file.parse.declarations[location.declarationIndex];

	return declaration !== undefined && file !== undefined && isStoredOracleDeclaration(file.parse, declaration);
};

type FileResolveResultType = Readonly<{
	occurrences: readonly IndexedOccurrenceType[];
	outArguments: readonly OutArgumentRangeType[];
	diagnostics: readonly DiagnosticType[];
}>;

const resolveFileReferences = (
	input: ResolveInputType,
	fileIndex: number,
	symbolDeclarations: ReadonlyMap<string, ResolvedDeclarationType>,
): FileResolveResultType => {
	const file = input.files[fileIndex];

	if (file === undefined) {
		return {occurrences: [], outArguments: [], diagnostics: []};
	}

	const collector = new OracleDiagnosticCollector(file.path);
	const state: ResolveStateType = {input, fileIndex, file, symbolDeclarations, diagnostics: collector};
	const occurrences: IndexedOccurrenceType[] = [];
	const outArguments: OutArgumentRangeType[] = [];

	for (const site of file.parse.references) {
		const symbolId = resolveSite(state, site);

		if (symbolId === null || (input.storedOnly === true && !isStoredTarget(symbolId, symbolDeclarations, input.files))) {
			continue;
		}

		occurrences.push(occurrenceOf({context: input.context, path: file.path, site, symbolId, enclosingId: storedOwnerOf(file, site.enclosing)}));

		const location = symbolDeclarations.get(symbolId);
		const target = location === undefined ? undefined : input.files[location.fileIndex]?.parse.declarations[location.declarationIndex];

		if (target !== undefined) {
			outArguments.push(...outArgumentRangesOf(site, target, file.path));
		}
	}

	return {occurrences, outArguments, diagnostics: collector.finish()};
};

/**
 * Resolves statically provable Oracle references against indexed declarations.
 *
 * Unprovable names, dynamic SQL, strings, and comments produce no occurrence.
 * Ambiguous overload calls produce one bounded diagnostic and no occurrence.
 *
 * @param input - Context, schema, parsed analyses, and package lookup tables.
 * @returns Reference occurrences and bounded diagnostics.
 */
export const resolveOracleReferences = (input: ResolveInputType): OracleResolvedReferencesType => {
	const symbolDeclarations = buildSymbolDeclarations(input.files);
	const results = input.files.map((_file, fileIndex) => resolveFileReferences(input, fileIndex, symbolDeclarations));
	const occurrences = refineOutArgumentUsage(
		results.flatMap((result) => result.occurrences),
		results.flatMap((result) => result.outArguments),
	);
	const diagnostics = results.flatMap((result) => result.diagnostics);
	const sorted = [...occurrences].sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.startOffset - right.startOffset ||
			left.symbolId.localeCompare(right.symbolId) ||
			left.role.localeCompare(right.role),
	);

	return {occurrences: sorted, diagnostics};
};
