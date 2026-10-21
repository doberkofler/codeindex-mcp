import {chooseCandidateOf} from './resolveCandidates.ts';
import {type ChoiceCandidateType, type ResolutionType, type ResolveStateType} from './resolveReferences.ts';
import {directChildren, memberChoice, recordFieldResolution, resolveRecordChain} from './resolveRecords.ts';
import {type ResolutionServicesType} from './resolveTypes.ts';
import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {type OracleDeclarationType, type OracleReferenceSiteType} from './syntax.ts';

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

export const resolveSimpleAt = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	name: Readonly<{startDeclaration: number; canonical: string}>,
	site: OracleReferenceSiteType,
): ResolutionType => {
	let current: number | null = name.startDeclaration;

	while (current !== null) {
		const candidates = directChildren(state.file, current, name.canonical);

		if (candidates.length > 0) {
			const result = chooseCandidateOf(services, {candidates, site}, state, true);

			return {symbolId: result.choice?.symbolId ?? null, outcome: result.outcome};
		}

		current = state.file.parse.declarations[current]?.parent ?? null;
	}

	const declaration = state.file.parse.declarations[name.startDeclaration];
	const packageCanonical = declaration === undefined ? null : packageOfDeclaration(state.file, name.startDeclaration);
	const members = packageMembers(state, packageCanonical, name.canonical);

	if (members.length === 0) {
		return {symbolId: null, outcome: 'no-declaration'};
	}

	const result = chooseCandidateOf(services, {candidates: members, site}, state, true);

	return {symbolId: result.choice?.symbolId ?? null, outcome: result.outcome};
};

export const syntheticSite = (declaration: OracleDeclarationType, declarationIndex: number): OracleReferenceSiteType => ({
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

const packageCanonicalOf = (parts: OracleReferenceSiteType['name']['parts'], defaultSchema: string, packagePartCount: number): string =>
	packagePartCount === 1
		? `${defaultSchema}.${parts[0]?.canonical ?? ''}`
		: parts
				.slice(0, 2)
				.map((part) => part.canonical)
				.join('.');

const resolvePackagePath = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	path: Readonly<{parts: OracleReferenceSiteType['name']['parts']; packagePartCount: number}>,
	site: OracleReferenceSiteType,
): ResolutionType => {
	const {parts, packagePartCount} = path;
	const packageCanonical = packageCanonicalOf(parts, state.input.defaultSchema, packagePartCount);
	const member = parts[packagePartCount];

	if (member === undefined) {
		return {symbolId: null, outcome: 'no-package-member'};
	}

	if (state.input.packages.get(packageCanonical) === undefined) {
		return {symbolId: null, outcome: 'no-package'};
	}

	const selected = chooseCandidateOf(services, {candidates: packageMembers(state, packageCanonical, member.canonical), site}, state, true);

	if (selected.choice === null) {
		return {symbolId: null, outcome: selected.outcome};
	}

	let {symbolId} = selected.choice;

	for (const part of parts.slice(packagePartCount + 1)) {
		const field = recordFieldResolution(services, state, {symbolId, canonical: part.canonical}, 0);

		if (field.symbolId === null) {
			return field;
		}

		({symbolId} = field);
	}

	return {symbolId, outcome: 'resolved'};
};

export const resolvePackageMember = (
	services: ResolutionServicesType,
	state: ResolveStateType,
	parts: OracleReferenceSiteType['name']['parts'],
	site: OracleReferenceSiteType,
): ResolutionType => {
	const primary = parts.length >= 3 ? 2 : 1;
	const counts = primary === 2 && parts.length === 3 ? [2, 1] : [primary];
	let last: ResolutionType = {symbolId: null, outcome: 'no-package-member'};

	for (const count of counts) {
		const result = resolvePackagePath(services, state, {parts, packagePartCount: count}, site);

		if (result.symbolId !== null) {
			return result;
		}

		if (result.outcome !== 'no-package') {
			last = result;
		}
	}

	return last;
};

export const resolveSite = (services: ResolutionServicesType, state: ResolveStateType, site: OracleReferenceSiteType): ResolutionType => {
	const [first] = site.name.parts;

	if (site.name.parts.length === 1) {
		return resolveSimpleAt(services, state, {startDeclaration: site.enclosing, canonical: first?.canonical ?? ''}, site);
	}

	const chain = resolveRecordChain(services, state, site.name.parts, site);

	if (chain.symbolId !== null) {
		return chain;
	}

	const member = resolvePackageMember(services, state, site.name.parts, site);

	if (member.symbolId !== null) {
		return member;
	}

	return chain.outcome === 'no-declaration' ? member : chain;
};
