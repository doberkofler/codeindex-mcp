import {
	type DefinitionSiteSummaryType,
	type QueryFreshnessType,
	type ReadSymbolResultType,
	type ReadSymbolTextResultType,
	type ReferenceCandidateType,
	type SymbolSummaryType,
} from '../model.ts';
import {readSymbolSource, type ReadSymbolSourceType} from './readSymbolSource.ts';

export type ReadSymbolResultInputType = Readonly<{
	content: string;
	symbol: SymbolSummaryType;
	site: DefinitionSiteSummaryType;
	generationId: string;
	freshness: QueryFreshnessType;
	contextLines: number;
	maxReadLines: number;
	maxResultBytes: number;
}>;

const NONE_MESSAGE =
	'No stored symbol matched this query. This is not evidence that no source defines it: the index covers only configured projects and indexing may be incomplete. Use a repository text search as the fallback.';

/**
 * Builds the explicit fallback result for a natural query with no stored match.
 *
 * @param generationId - Published generation identifier.
 * @param freshness - Current generation freshness.
 * @returns An explicit no-match result with repository fallback guidance.
 */
export const readSymbolNoneResult = (generationId: string, freshness: QueryFreshnessType): ReadSymbolResultType => ({
	kind: 'none',
	generationId,
	freshness,
	selector: 'query',
	reason: 'no_stored_match',
	fallback: 'text_search',
	message: NONE_MESSAGE,
	limitations: ['Only configured extractor projects are indexed.', 'Indexing may be incomplete.', 'A missing stored symbol is not a source-absence claim.'],
});

/**
 * Builds a byte-bounded ambiguity result without silently selecting a symbol.
 *
 * @param input - Generation, freshness, candidates, total count, and byte bound.
 * @returns A bounded ambiguity result.
 */
export const readSymbolAmbiguousResult = (
	input: Readonly<{
		generationId: string;
		freshness: QueryFreshnessType;
		candidates: readonly ReferenceCandidateType[];
		total: number;
		maxResultBytes: number;
	}>,
): ReadSymbolResultType => {
	const candidates = [...input.candidates];
	const createResult = (): ReadSymbolResultType => ({
		kind: 'ambiguous',
		generationId: input.generationId,
		freshness: input.freshness,
		selector: 'query',
		candidates,
		candidatesTotal: input.total,
		candidatesTruncated: input.total > candidates.length,
	});

	while (candidates.length > 0 && Buffer.byteLength(JSON.stringify(createResult()), 'utf8') > input.maxResultBytes) {
		candidates.pop();
	}

	return createResult();
};

/**
 * Builds one read_symbol text result whose serialized data fits the byte budget.
 *
 * The first pass bounds the source alone. Later passes reserve the serialized
 * metadata and truncation fields, so the complete result never relies on the
 * transport to replace it with `response_too_large`.
 *
 * @param input - Source text, symbol and definition-site metadata, and response bounds.
 * @returns A source slice bounded with its complete result metadata.
 */
export const readSymbolResult = (input: ReadSymbolResultInputType): ReadSymbolTextResultType => {
	const readSource = (budget: number): ReadSymbolSourceType =>
		readSymbolSource({
			content: input.content,
			symbolStartLine: input.site.startLine,
			symbolEndLine: input.site.endLine,
			maxReadLines: input.maxReadLines,
			maxResultBytes: Math.max(1, budget),
			contextLines: input.contextLines,
		});
	const createResult = (source: ReadSymbolSourceType): ReadSymbolTextResultType => ({
		kind: 'text',
		generationId: input.generationId,
		freshness: input.freshness,
		symbol: input.symbol,
		site: input.site,
		path: input.symbol.path,
		startLine: source.startLine,
		endLine: source.endLine,
		source: source.source,
		truncated: source.truncatedReason !== null,
		truncatedReason: source.truncatedReason,
	});
	let source = readSource(input.maxResultBytes);

	for (let attempt = 0; attempt < 3; attempt += 1) {
		const result = createResult(source);

		if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= input.maxResultBytes) {
			return result;
		}

		const reserved = Buffer.byteLength(JSON.stringify({...result, source: ''}), 'utf8');
		const budget = input.maxResultBytes - reserved;

		source = budget <= 0 ? {startLine: source.startLine, endLine: source.startLine, source: '', truncatedReason: 'bytes'} : readSource(budget);
	}

	return createResult(source);
};
