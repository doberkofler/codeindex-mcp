import {type QueryFreshnessType, type SymbolAtInputType, type SymbolAtResultType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {normalizeRelativePath} from './querySupport.ts';
import {assertPathAdapter} from './queryScope.ts';

/**
 * Resolves one source position to the innermost stored definition.
 *
 * @param input - Published generation, freshness, configured adapters, and path/position selector.
 * @returns Candidates, ambiguity, lexical ancestors, and absence reason.
 * @throws {@link CodeIndexError} When the adapter is unknown, does not own the
 * path, the path is unknown, or the response exceeds its bound.
 */
export const querySymbolAt = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		freshness: QueryFreshnessType;
		adapters: readonly string[];
		selector: SymbolAtInputType;
		maxResultBytes: number;
	}>,
): SymbolAtResultType => {
	const pathName = normalizeRelativePath(input.selector.path);

	if (input.selector.adapter !== undefined && !input.adapters.includes(input.selector.adapter)) {
		throw new CodeIndexError('unknown_adapter', `Unknown adapter: ${input.selector.adapter}`);
	}

	if (input.selector.adapter !== undefined) {
		assertPathAdapter({
			adapter: input.selector.adapter,
			owner: input.database.fileAdapter(input.generationId, pathName),
			path: pathName,
		});
	}

	if (input.database.getFile(input.generationId, pathName) === null) {
		throw new CodeIndexError('file_not_indexed', `File is not in the published index: ${pathName}`);
	}

	const candidates = input.database.symbolsAtPosition({
		generationId: input.generationId,
		path: pathName,
		line: input.selector.line,
		column: input.selector.column ?? null,
	});
	const selected = input.selector.column === undefined ? candidates : candidates.slice(0, 1);
	const ambiguous = input.selector.column === undefined && selected.length > 1;
	const [first] = selected;
	const result: SymbolAtResultType = {
		generationId: input.generationId,
		freshness: input.freshness,
		path: pathName,
		line: input.selector.line,
		column: input.selector.column ?? null,
		candidates: selected,
		ambiguous,
		ancestors: first === undefined ? [] : input.database.symbolAncestors(input.generationId, first.symbol.id),
		reason: first === undefined ? 'no_stored_owner' : null,
	};

	if (Buffer.byteLength(JSON.stringify(result), 'utf8') > input.maxResultBytes) {
		throw new CodeIndexError('response_too_large', `Response exceeded ${input.maxResultBytes} bytes; request a smaller position result`);
	}

	return result;
};
