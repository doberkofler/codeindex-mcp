import {type QueryFreshnessType, type ReadSymbolResultType, type SymbolSummaryType} from '../model.ts';
import {readSymbolSource, type ReadSymbolSourceType} from './readSymbolSource.ts';

export type ReadSymbolResultInputType = Readonly<{
	content: string;
	symbol: SymbolSummaryType;
	generationId: string;
	freshness: QueryFreshnessType;
	contextLines: number;
	maxReadLines: number;
	maxResultBytes: number;
}>;

/**
 * Builds one read_symbol result whose serialized data fits the byte budget.
 *
 * The first pass bounds the source alone. Later passes reserve the serialized
 * metadata and truncation fields, so the complete result never relies on the
 * transport to replace it with `response_too_large`.
 *
 * @param input - Source text, symbol metadata, and response bounds.
 * @returns A source slice bounded with its complete result metadata.
 */
export const readSymbolResult = (input: ReadSymbolResultInputType): ReadSymbolResultType => {
	const readSource = (budget: number): ReadSymbolSourceType =>
		readSymbolSource({
			content: input.content,
			symbolStartLine: input.symbol.startLine,
			symbolEndLine: input.symbol.endLine,
			maxReadLines: input.maxReadLines,
			maxResultBytes: Math.max(1, budget),
			contextLines: input.contextLines,
		});
	const createResult = (source: ReadSymbolSourceType): ReadSymbolResultType => ({
		generationId: input.generationId,
		freshness: input.freshness,
		symbol: input.symbol,
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
