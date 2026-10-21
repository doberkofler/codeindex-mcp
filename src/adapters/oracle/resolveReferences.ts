import {type DiagnosticType, type IndexedOccurrenceType} from '../../core/model.ts';
import {isStoredOracleDeclaration} from './declarationStorage.ts';
import {OracleDiagnosticCollector} from './diagnostics.ts';
import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {occurrenceOf} from './referenceOccurrences.ts';
import {bulkFieldSymbolsOf} from './resolveRecords.ts';
import {resolvePackageMember, resolveSite, syntheticSite, resolveSimpleAt} from './resolveScope.ts';
import {type ResolutionServicesType} from './resolveTypes.ts';
import {suppressNonRoutine} from './referenceScan.ts';
import {outArgumentRangesOf, refineOutArgumentUsage, type OutArgumentRangeType} from './referenceOutArguments.ts';
import {type OraclePackageLookupMapType} from './scopeGraph.ts';
import {type OracleDeclarationType, type OracleReferenceSiteType} from './syntax.ts';

type ResolvedDeclarationType = Readonly<{fileIndex: number; declarationIndex: number}>;

export type ChoiceCandidateType = Readonly<{
	symbolId: string;
	kind: string;
	declaration: OracleDeclarationType;
	path: string;
}>;

export type ChoiceType = Readonly<{choice: ChoiceCandidateType | null; outcome: OracleResolveOutcomeType}>;

export type ResolutionType = Readonly<{
	symbolId: string | null;
	outcome: OracleResolveOutcomeType;
}>;

/**
 * Why one reference site produced or failed to produce an occurrence.
 *
 * `resolved` and `not-stored` refer to sites that were emitted or deliberately
 * dropped after resolution; every other reason is an unresolved site.
 */

type OracleResolveOutcomeType =
	| 'resolved'
	| 'not-stored'
	| 'suppressed'
	| 'no-declaration'
	| 'ambiguous-overload'
	| 'no-field'
	| 'no-package'
	| 'no-package-member';

type OracleResolveTraceType = Readonly<{
	path: string;
	site: OracleReferenceSiteType;
	outcome: OracleResolveOutcomeType;
}>;

export type ResolveInputType = Readonly<{
	context: string;
	defaultSchema: string;
	files: readonly OracleFileAnalysisType[];
	packages: OraclePackageLookupMapType;
	/** Drop occurrences whose target is not a stored declaration class. */
	storedOnly?: boolean | undefined;
	/** Qualification-only observation point for resolution outcomes. */
	trace?: ((event: OracleResolveTraceType) => void) | undefined;
}>;

export type ResolveStateType = Readonly<{
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

const targetOf = (input: ResolveInputType, location: ResolvedDeclarationType | undefined): OracleDeclarationType | undefined =>
	location === undefined ? undefined : input.files[location.fileIndex]?.parse.declarations[location.declarationIndex];

const skipTarget = (
	input: Readonly<{target: OracleDeclarationType | undefined; location: ResolvedDeclarationType | undefined; fileIndex: number; site: OracleReferenceSiteType}>,
): boolean =>
	(input.target?.kind === 'package' && input.site.name.parts.length === 1) ||
	(input.target !== undefined && input.location !== undefined && input.location.fileIndex !== input.fileIndex && !input.target.exported) ||
	suppressNonRoutine(input.site, input.target);

const occurrenceSiteOf = (site: OracleReferenceSiteType, target: OracleDeclarationType | undefined): OracleReferenceSiteType => {
	if (target === undefined) {
		return site;
	}

	if (target.kind === 'procedure' || target.kind === 'function') {
		return site.kind === 'reference' ? {...site, kind: 'call', usage: 1} : site;
	}

	if (site.kind === 'call') {
		// A cursor invocation and a collection-type constructor are calls in
		// PL/Scope; an indexed collection read is not.
		const callable = target.kind === 'cursor' || target.kind === 'collection_type' || target.kind === 'record_type';

		return {...site, kind: callable ? 'call' : 'reference', usage: callable ? 1 : site.name.parts.length === 1 ? 2 : 1};
	}

	// A cursor named in a FOR header is invoked by the loop.
	if (target.kind === 'cursor' && site.forBound === true) {
		return {...site, kind: 'call', usage: 1};
	}

	return site;
};

const services: ResolutionServicesType = {
	resolveSimpleAt: (state, start, canonical, site) => resolveSimpleAt(services, state, {startDeclaration: start, canonical}, site),
	resolveMember: (state, parts, site) => resolvePackageMember(services, state, parts, site).symbolId,
	resolveSite: (state, site) => resolveSite(services, state, site),
	syntheticSite,
};

const siteOccurrencesOf = (
	context: Readonly<{input: ResolveInputType; state: ResolveStateType; site: OracleReferenceSiteType}>,
	resolved: Readonly<{symbolId: string; target: OracleDeclarationType | undefined; storedOnly: boolean}>,
): readonly IndexedOccurrenceType[] => {
	const {input, state, site} = context;
	const {symbolId, target, storedOnly} = resolved;
	const occurrenceSite = occurrenceSiteOf(site, target);
	const enclosingId = storedOwnerOf(state.file, site.enclosing);
	const occurrences: IndexedOccurrenceType[] = [occurrenceOf({context: input.context, path: state.file.path, site: occurrenceSite, symbolId, enclosingId})];

	for (const fieldId of site.bulkFields === undefined ? [] : bulkFieldSymbolsOf(services, state, symbolId, site.bulkFields)) {
		if (storedOnly && !isStoredTarget(fieldId, state.symbolDeclarations, input.files)) {
			continue;
		}

		occurrences.push(occurrenceOf({context: input.context, path: state.file.path, site: {...site, usage: 4}, symbolId: fieldId, enclosingId}));
	}

	return occurrences;
};

const bulkMarkerOccurrences = (
	input: ResolveInputType,
	state: ResolveStateType,
	site: OracleReferenceSiteType,
	storedOnly: boolean,
): readonly IndexedOccurrenceType[] => {
	const marker = resolveSite(services, state, site);

	if (marker.symbolId === null) {
		return [];
	}

	const enclosingId = storedOwnerOf(state.file, site.enclosing);
	const occurrences: IndexedOccurrenceType[] = [];

	for (const fieldId of bulkFieldSymbolsOf(services, state, marker.symbolId, site.bulkFields ?? null)) {
		if (storedOnly && !isStoredTarget(fieldId, state.symbolDeclarations, input.files)) {
			continue;
		}

		occurrences.push(occurrenceOf({context: input.context, path: state.file.path, site, symbolId: fieldId, enclosingId}));
	}

	return occurrences;
};

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
	const {storedOnly, files} = input;
	const occurrences: IndexedOccurrenceType[] = [];
	const outArguments: OutArgumentRangeType[] = [];

	for (const site of file.parse.references) {
		// A bulk marker expands into stored element fields even when the target
		// itself is an unindexed local or parameter.
		if (site.bulkFields !== undefined) {
			occurrences.push(...bulkMarkerOccurrences(input, state, site, storedOnly === true));
			continue;
		}

		const resolution = resolveSite(services, state, site);

		if (resolution.symbolId === null) {
			input.trace?.({path: file.path, site, outcome: resolution.outcome});
			continue;
		}

		const {symbolId} = resolution;

		if (storedOnly === true && !isStoredTarget(symbolId, symbolDeclarations, files)) {
			input.trace?.({path: file.path, site, outcome: 'not-stored'});
			continue;
		}

		const location = symbolDeclarations.get(symbolId);
		const target = targetOf(input, location);

		if (skipTarget({target, location, fileIndex, site})) {
			input.trace?.({path: file.path, site, outcome: 'suppressed'});
			continue;
		}

		input.trace?.({path: file.path, site, outcome: 'resolved'});

		occurrences.push(...siteOccurrencesOf({input, state, site}, {symbolId, target, storedOnly: storedOnly === true}));

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
