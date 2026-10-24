import {type CodeIndex} from '../generation/codeIndex.ts';
import {type BenchmarkPercentilesType} from './benchTypes.ts';
import {measure, summarize} from './percentiles.ts';

/**
 * Measures cached status and bounded query latency without model calls.
 *
 * The symbol query is a corpus-derived prefix and requests a full page, so the
 * sample exercises candidate ranking and page truncation instead of an empty
 * or single-row result.
 *
 * @param index - Built index.
 * @param outlinePath - Indexed source file for outline queries.
 * @param sample - Optional symbol for reference and source reads.
 * @param iterations - Rounds per query.
 * @returns Latency samples by query name.
 */
export const measureQueries = (
	index: CodeIndex,
	outlinePath: string,
	sample: Readonly<{id: string; name: string}> | undefined,
	iterations: number,
): Readonly<Record<string, number[]>> => {
	const queries: Record<string, number[]> = {
		status: [],
		find_symbol: [],
		outline: [],
		find_references: [],
		read_symbol: [],
	};
	const symbolQuery = sample === undefined || sample.name.length === 0 ? 'a' : sample.name.slice(0, 3);

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		queries['status']?.push(
			measure(() => {
				index.getStatus();
			}),
		);
		queries['find_symbol']?.push(
			measure(() => {
				index.findSymbols({query: symbolQuery, limit: 200});
			}),
		);
		queries['outline']?.push(
			measure(() => {
				index.getOutline({path: outlinePath, limit: 50});
			}),
		);

		if (sample !== undefined) {
			queries['find_references']?.push(
				measure(() => {
					index.findReferences({symbolId: sample.id, limit: 50});
				}),
			);
			queries['read_symbol']?.push(
				measure(() => {
					index.readSymbol({symbolId: sample.id, contextLines: 0});
				}),
			);
		}
	}

	return queries;
};

/**
 * Summarizes raw query samples.
 *
 * @param queries - Latency samples by query name.
 * @returns Percentile summaries.
 */
export const summarizeQueries = (queries: Readonly<Record<string, readonly number[]>>): Readonly<Record<string, BenchmarkPercentilesType>> =>
	Object.fromEntries(Object.entries(queries).map(([name, values]) => [name, summarize(values)]));
