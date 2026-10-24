import {type IndexDatabase} from '../storage/database.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {type FindReferencesInputType, type ReferenceCandidateType} from '../model.ts';

type SymbolCandidateType = Readonly<{
	symbolId: string;
	name: string;
	qualifiedName: string;
	kind: string;
	path: string;
	startLine: number;
	endLine: number;
	match: ReferenceCandidateType['match'];
	exposure: 'published' | 'reachable' | 'internal';
	container: string;
	bindingId: string;
}>;

export type ReferenceResolutionType =
	| Readonly<{kind: 'resolved'; symbolId: string}>
	| Readonly<{kind: 'ambiguous'; candidates: readonly ReferenceCandidateType[]; total: number}>
	| Readonly<{kind: 'none'}>;

const MAX_AMBIGUOUS_CANDIDATES = 5;
const CANDIDATE_FETCH_LIMIT = 5000;
const SELECTOR_MESSAGE = 'Provide exactly one selector: symbolId or query';

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const matchRank = (match: ReferenceCandidateType['match']): number => (match.startsWith('exact') ? 0 : 1);

const exposureRank = (exposure: 'published' | 'reachable' | 'internal'): number => (exposure === 'published' ? 2 : exposure === 'reachable' ? 1 : 0);

const compareCandidates = (left: SymbolCandidateType, right: SymbolCandidateType): number =>
	matchRank(left.match) - matchRank(right.match) ||
	exposureRank(right.exposure) - exposureRank(left.exposure) ||
	compareText(left.container, right.container) ||
	compareText(left.name, right.name) ||
	compareText(left.bindingId, right.bindingId) ||
	compareText(left.path, right.path) ||
	compareText(left.symbolId, right.symbolId);

const compactCandidateOf = (candidate: SymbolCandidateType): ReferenceCandidateType => ({
	symbolId: candidate.symbolId,
	name: candidate.name,
	qualifiedName: candidate.qualifiedName,
	kind: candidate.kind,
	path: candidate.path,
	startLine: candidate.startLine,
	endLine: candidate.endLine,
	match: candidate.match,
});

/**
 * Validates that the caller supplied exactly one reference selector.
 *
 * @param input - Reference query input.
 * @returns The selected selector name.
 * @throws {@link CodeIndexError} When both or neither selector is present.
 */
export const assertReferenceSelector = (input: FindReferencesInputType): 'symbolId' | 'query' => {
	const hasSymbolId = input.symbolId !== undefined;
	const hasQuery = input.query !== undefined;

	if (hasSymbolId === hasQuery) {
		throw new CodeIndexError('invalid_argument', hasSymbolId ? `${SELECTOR_MESSAGE}; both were provided` : `${SELECTOR_MESSAGE}; neither was provided`);
	}

	return hasSymbolId ? 'symbolId' : 'query';
};

const queryCandidates = (database: IndexDatabase, generationId: string, input: FindReferencesInputType): readonly SymbolCandidateType[] => {
	const query = (input.query ?? '').trim();
	const bestBySymbol = new Map<string, SymbolCandidateType>();
	const candidates = database.findBindingCandidates({
		generationId,
		query,
		match: input.match ?? 'name',
		...(input.kind === undefined ? {} : {kind: input.kind}),
		...(input.container === undefined ? {} : {container: input.container}),
		...(input.path === undefined ? {} : {path: input.path}),
		...(input.context === undefined ? {} : {context: input.context}),
		exposure: input.exposure ?? 'visible',
		fetchLimit: CANDIDATE_FETCH_LIMIT,
	});
	const summaries = database.symbolSummaries(generationId, [...new Set(candidates.map((candidate) => candidate.symbolId))]);

	for (const candidate of candidates) {
		const symbol = summaries.get(candidate.symbolId);

		if (symbol === undefined) {
			continue;
		}

		const next: SymbolCandidateType = {
			symbolId: symbol.id,
			name: symbol.name,
			qualifiedName: symbol.qualifiedName,
			kind: symbol.kind,
			path: symbol.path,
			startLine: symbol.startLine,
			endLine: symbol.endLine,
			match: candidate.match,
			exposure: candidate.binding.exposure,
			container: candidate.binding.container,
			bindingId: candidate.binding.bindingId,
		};
		const current = bestBySymbol.get(next.symbolId);

		if (current === undefined || compareCandidates(next, current) < 0) {
			bestBySymbol.set(next.symbolId, next);
		}
	}

	return [...bestBySymbol.values()].sort((left, right) => compareCandidates(left, right));
};

const resolutionOf = (ordered: readonly SymbolCandidateType[]): ReferenceResolutionType => {
	if (ordered.length === 0) {
		return {kind: 'none'};
	}

	const exact = ordered.filter((candidate) => matchRank(candidate.match) === 0);
	const contenders = exact.length > 0 ? exact : ordered;
	const [resolved] = contenders;

	if (contenders.length === 1 && resolved !== undefined) {
		return {kind: 'resolved', symbolId: resolved.symbolId};
	}

	return {
		kind: 'ambiguous',
		candidates: contenders.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((candidate) => compactCandidateOf(candidate)),
		total: contenders.length,
	};
};

/**
 * Resolves one query to a single symbol, or reports ambiguity without reading source.
 *
 * Exact candidates win over prefix candidates so an exact identifier still
 * resolves when unrelated names share its prefix. Multiple exact candidates
 * remain ambiguous.
 *
 * @param database - Reader database.
 * @param generationId - Published generation.
 * @param input - Query selector text, match mode, and symbol filters.
 * @returns A resolved symbol, bounded candidates, or no stored match.
 * @throws {@link CodeIndexError} When the query is empty without a container.
 */
export const resolveReferenceQuery = (database: IndexDatabase, generationId: string, input: FindReferencesInputType): ReferenceResolutionType => {
	if ((input.query ?? '').trim().length === 0 && input.container === undefined) {
		throw new CodeIndexError('invalid_argument', 'Query must not be empty without a container');
	}

	return resolutionOf(queryCandidates(database, generationId, input));
};
