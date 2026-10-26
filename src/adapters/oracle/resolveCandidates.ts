import {ORACLE_DIAGNOSTIC} from './diagnostics.ts';
import {type ChoiceCandidateType, type ChoiceType, type ResolveStateType} from './resolveReferences.ts';
import {filterByTypes, type ResolutionServicesType} from './resolveTypes.ts';
import {type OracleReferenceSiteType} from './syntax.ts';

const nextFreePosition = (parameters: ChoiceCandidateType['declaration']['parameters'], supplied: ReadonlySet<string>, from: number): number => {
	let position = from;

	while (position < parameters.length && supplied.has(parameters[position]?.name.canonical ?? '')) {
		position += 1;
	}

	return position;
};

const addNamedSupply = (
	supplied: Set<string>,
	parameters: ChoiceCandidateType['declaration']['parameters'],
	argumentsWithNames: NonNullable<OracleReferenceSiteType['arguments']>,
): void => {
	const byName = new Map(parameters.map((parameter) => [parameter.name.canonical, parameter]));
	let position = 0;

	for (const argument of argumentsWithNames) {
		const named = argument.name === null ? undefined : byName.get(argument.name);

		if (named !== undefined) {
			supplied.add(named.name.canonical);
			continue;
		}

		position = nextFreePosition(parameters, supplied, position);

		const parameter = parameters[position];

		if (parameter !== undefined) {
			supplied.add(parameter.name.canonical);
		}
	}
};

const addLeadingSupply = (supplied: Set<string>, parameters: ChoiceCandidateType['declaration']['parameters'], count: number): void => {
	for (let index = 0; index < count && index < parameters.length; index += 1) {
		supplied.add(parameters[index]?.name.canonical ?? '');
	}
};

const suppliedNames = (candidate: ChoiceCandidateType, site: OracleReferenceSiteType): ReadonlySet<string> => {
	const {parameters} = candidate.declaration;
	const supplied = new Set(site.argumentNames);
	const args = site.arguments ?? [];

	if (args.length === 0) {
		addLeadingSupply(supplied, parameters, site.argumentCount ?? 0);
	} else {
		addNamedSupply(supplied, parameters, args);
	}

	return supplied;
};

/**
 * Reports whether a named association cannot belong to one candidate.
 *
 * Oracle matches a named association by parameter name, so a name that the
 * candidate does not declare rejects the whole candidate. Treating such an
 * association as positional would let a wider overload fit a call that only
 * the narrower overload accepts.
 *
 * @param candidate - Candidate declaration.
 * @param site - Authored call site.
 * @returns Whether any named association is unknown to the candidate.
 */
const hasUnknownNamedArgument = (candidate: ChoiceCandidateType, site: OracleReferenceSiteType): boolean => {
	const args = site.arguments ?? [];

	if (args.length === 0) {
		return false;
	}

	const known = new Set(candidate.declaration.parameters.map((parameter) => parameter.name.canonical));

	return args.some((argument) => argument.name !== null && !known.has(argument.name));
};

const fitsArguments = (candidate: ChoiceCandidateType, site: OracleReferenceSiteType): boolean => {
	const {parameters} = candidate.declaration;
	const provided = site.argumentCount ?? 0;

	if (provided > parameters.length) {
		return false;
	}

	if (hasUnknownNamedArgument(candidate, site)) {
		return false;
	}

	const supplied = suppliedNames(candidate, site);

	// A named call may omit trailing parameters, but never a required one.
	return parameters.every((parameter) => parameter.hasDefault || supplied.has(parameter.name.canonical));
};

const fitsArgumentTypes = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	candidates: readonly ChoiceCandidateType[],
	site: OracleReferenceSiteType,
): readonly ChoiceCandidateType[] => {
	if (candidates.length <= 1) {
		return candidates;
	}

	let filtered = candidates;

	if (site.statementCall !== undefined && candidates.every((candidate) => candidate.kind === 'procedure' || candidate.kind === 'function')) {
		const positional = candidates.filter((candidate) => candidate.kind === (site.statementCall === true ? 'procedure' : 'function'));

		if (positional.length > 0) {
			filtered = positional;
		}
	}

	if (site.kind !== 'call' || site.arguments === undefined || filtered.length <= 1) {
		return filtered;
	}

	const exact = filterByTypes(services, state, filtered, {site, exact: true});

	if (exact.length === 1) {
		return exact;
	}

	const family = filterByTypes(services, state, filtered, {site, exact: false});

	if (family.length === 1) {
		return family;
	}

	const result = exact.length > 1 ? exact : family.length > 1 ? family : filtered;

	return result;
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

/**
 * Reports one ambiguous-overload site at the callee token.
 *
 * @param state - Resolution state that owns the diagnostic collector.
 * @param site - Authored call or reference site.
 * @param enabled - Whether ambiguity reporting is enabled for this resolution.
 */
const reportAmbiguousOverload = (state: ResolveStateType, site: OracleReferenceSiteType, enabled: boolean): void => {
	if (!enabled) {
		return;
	}

	state.diagnostics.add(ORACLE_DIAGNOSTIC.ambiguousOverload, `Ambiguous overload for ${site.name.text}`, site.nameRange.startLine, site.nameRange.startColumn);
};

export const chooseCandidateOf = (
	services: ResolutionServicesType,
	request: Readonly<{candidates: readonly ChoiceCandidateType[]; site: OracleReferenceSiteType}>,
	state: ResolveStateType,
	reportAmbiguity: boolean,
): ChoiceType => {
	const {candidates, site} = request;
	const seen = new Set<string>();
	const valid = candidates.filter((candidate) => {
		if (candidate.symbolId === '' || seen.has(candidate.symbolId)) {
			return false;
		}

		seen.add(candidate.symbolId);
		return true;
	});

	if (valid.length <= 1) {
		return valid[0] === undefined ? {choice: null, outcome: 'no-declaration'} : {choice: valid[0], outcome: 'resolved'};
	}

	if (site.kind === 'call') {
		const fitting = fitsArgumentTypes(
			services,
			state,
			valid.filter((candidate) => (candidate.kind === 'procedure' || candidate.kind === 'function' ? fitsArguments(candidate, site) : false)),
			site,
		);

		if (fitting.length === 1) {
			return {choice: fitting[0] ?? null, outcome: 'resolved'};
		}

		if (fitting.length > 1) {
			// A diagnostic marks the callee, matching the position PL/Scope
			// reports for the CALL row that the contract omits.
			reportAmbiguousOverload(state, site, reportAmbiguity);

			return {choice: null, outcome: 'ambiguous-overload'};
		}

		// A call-shaped site can be collection or record indexing rather than a
		// routine call. Fall back to a non-routine only when no callable fits.
		const fallback = nearestNonRoutine(valid, site, state);

		return fallback === null ? {choice: null, outcome: 'no-declaration'} : {choice: fallback, outcome: 'resolved'};
	}

	const nearest = nearestNonRoutine(valid, site, state);

	if (nearest !== null) {
		return {choice: nearest, outcome: 'resolved'};
	}

	// Every candidate is a routine. A site without parentheses invokes the
	// routine with no arguments, so arity still discriminates overloads.
	if (site.kind !== 'type-anchor') {
		const asCall: OracleReferenceSiteType = {...site, kind: 'call', argumentCount: site.argumentCount ?? 0};
		const fitting = valid.filter((candidate) => fitsArguments(candidate, asCall));

		if (fitting.length === 1) {
			return {choice: fitting[0] ?? null, outcome: 'resolved'};
		}

		if (fitting.length === 0) {
			return {choice: null, outcome: 'no-declaration'};
		}

		reportAmbiguousOverload(state, site, reportAmbiguity);
	}

	return {choice: null, outcome: 'ambiguous-overload'};
};
