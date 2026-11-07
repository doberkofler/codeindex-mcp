import * as ts from './compiler.ts';
import {type SourceFileType} from '@codeindex/adapter-sdk';
import {resolveCandidateAliasTargets} from './aliasTargets.ts';
import {createIdentifierSymbols, type IdentifierSymbolsType} from './identifierSymbols.ts';
import {type LoadedProjectType} from './loadProject.ts';
import {resolveCanonicalFrom} from './resolveSymbols.ts';

export type CandidateResolutionType = Readonly<{
	identifierSymbols: IdentifierSymbolsType;
	fullIdentifierSymbols: IdentifierSymbolsType | null;
	identifierCount: number;
	candidateAliasTargets: ReadonlyMap<number, ts.Symbol | null>;
	symbolAt: (node: ts.Node) => ts.Symbol | undefined;
	canonicalAt: (node: ts.Node) => ts.Symbol | undefined;
}>;

/**
 * Creates bounded direct and canonical symbol resolvers for candidate collection.
 *
 * @param input - Loaded compiler project and authored source manifest.
 * @returns Candidate lookup maps and direct/canonical resolver functions.
 */
export const createCandidateResolution = (input: Readonly<{project: LoadedProjectType; files: readonly SourceFileType[]}>): CandidateResolutionType => {
	const {checker, program} = input.project;
	const identifiers = createIdentifierSymbols(
		checker,
		program,
		input.files.map((file) => file.absolutePath),
	);
	const {symbols: identifierSymbols, candidateSymbols, fullSymbols: fullIdentifierSymbols, identifierCount} = identifiers;
	const candidateAliasTargets = resolveCandidateAliasTargets(input.project.batch, checker, candidateSymbols.values());
	const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
		if (identifierSymbols.has(node)) {
			return identifierSymbols.get(node);
		}

		if (fullIdentifierSymbols === null) {
			throw new Error('Large-project candidate symbol was not included in the bulk resolution plan');
		}

		return checker.getSymbolAtLocation(node);
	};
	const canonicalAt = (node: ts.Node): ts.Symbol | undefined => {
		if (fullIdentifierSymbols !== null) {
			return resolveCanonicalFrom(symbolAt, checker, node);
		}

		const direct = symbolAt(node);

		if (direct === undefined || (direct.flags & ts.SymbolFlags.Alias) === 0) {
			return direct;
		}

		return candidateAliasTargets.get(direct.id) ?? undefined;
	};

	return {identifierSymbols, fullIdentifierSymbols, identifierCount, candidateAliasTargets, symbolAt, canonicalAt};
};
