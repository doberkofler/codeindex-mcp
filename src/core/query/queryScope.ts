import {CodeIndexError} from '../errors/errors.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {normalizeQueryText, type QueryNameNormalizerType} from './querySupport.ts';

/** Resolved adapter and context addressing for one query. */
export type QueryScopeType = Readonly<{
	/** Undefined means every configured adapter. */
	adapter: string | undefined;
	/** Undefined means every context of the selected adapters. */
	context: string | undefined;
}>;

export type QueryScopeInputType = Readonly<{
	database: IndexDatabase;
	generationId: string;
	/** Configured adapter identifiers in declaration order. */
	adapters: readonly string[];
	normalizers: ReadonlyMap<string, QueryNameNormalizerType>;
	adapter?: string | undefined;
	context?: string | undefined;
}>;

/** One adapter's folded spelling of the authored query. */
export type NormalizedQueryEntryType = Readonly<{adapter: string; query: string}>;

const configuredAdaptersOf = (input: Readonly<{adapters: readonly string[]; adapter?: string | undefined}>): readonly string[] =>
	input.adapter === undefined ? input.adapters : [input.adapter];

const unknownAdapter = (adapter: string): CodeIndexError => new CodeIndexError('unknown_adapter', `Unknown adapter: ${adapter}`);

/**
 * Resolves one optional adapter filter and one optional context filter.
 *
 * A bare context name must exist under exactly one adapter. Supplying both
 * requires that exact pair. Unknown values never degrade to an empty success.
 *
 * @param input - Database, generation, configured adapters, and requested filters.
 * @returns The normalized adapter and context filters.
 * @throws {@link CodeIndexError} When the adapter is unknown, the context is
 * unknown, the context is ambiguous, or the pair does not exist.
 */
export const resolveQueryScope = (input: QueryScopeInputType): QueryScopeType => {
	const {adapter, context} = input;

	if (adapter !== undefined && !input.adapters.includes(adapter)) {
		throw unknownAdapter(adapter);
	}

	if (context === undefined) {
		return {adapter, context: undefined};
	}

	const entries = input.database.listProjectContextEntries(input.generationId);

	if (adapter !== undefined) {
		if (!entries.some((entry) => entry.adapterId === adapter && entry.name === context)) {
			if (entries.some((entry) => entry.name === context)) {
				throw new CodeIndexError('adapter_context_mismatch', `Context ${context} is not defined for adapter ${adapter}`);
			}

			throw new CodeIndexError('unknown_context', `Unknown project context: ${context}`);
		}

		return {adapter, context};
	}

	const matches = entries.filter((entry) => entry.name === context);

	if (matches.length === 0) {
		throw new CodeIndexError('unknown_context', `Unknown project context: ${context}`);
	}

	const adapterIds = [...new Set(matches.map((entry) => entry.adapterId))];
	const [only] = adapterIds;

	if (adapterIds.length !== 1 || only === undefined) {
		throw new CodeIndexError(
			'ambiguous_context',
			`Context ${context} exists under more than one adapter: ${adapterIds.sort().join(', ')}. Supply adapter together with context.`,
		);
	}

	return {adapter: only, context};
};

/**
 * Folds one authored query with every adapter selected by the scope.
 *
 * A filtered query uses only the selected adapter's normalizer. An unfiltered
 * query keeps one entry per configured adapter so their normalizations are not
 * attributed to one another.
 *
 * @param input - Resolved scope, configured adapters, normalizers, and authored text.
 * @returns One normalized query per selected adapter.
 */
export const normalizedQueryEntries = (
	input: Readonly<{
		scope: QueryScopeType;
		adapters: readonly string[];
		normalizers: ReadonlyMap<string, QueryNameNormalizerType>;
		text: string | undefined;
	}>,
): readonly NormalizedQueryEntryType[] => {
	if (input.text === undefined) {
		return [];
	}

	return configuredAdaptersOf({adapters: input.adapters, ...(input.scope.adapter === undefined ? {} : {adapter: input.scope.adapter})}).map((adapter) => ({
		adapter,
		query: normalizeQueryText(input.normalizers.get(adapter), input.text ?? ''),
	}));
};

/**
 * Groups adapters that fold the authored text to the same spelling.
 *
 * The unfiltered query issues one statement per distinct spelling instead of
 * one statement per adapter when normalizers agree.
 *
 * @param entries - Normalized query entries.
 * @returns Distinct spellings with the adapters that share them.
 */
export const groupNormalizedQueries = (entries: readonly NormalizedQueryEntryType[]): readonly Readonly<{query: string; adapters: readonly string[]}>[] => {
	const groups = new Map<string, string[]>();

	for (const entry of entries) {
		const adapters = groups.get(entry.query) ?? [];

		adapters.push(entry.adapter);
		groups.set(entry.query, adapters);
	}

	return [...groups.entries()].map(([query, adapters]) => ({query, adapters}));
};

/**
 * Requires one indexed path to belong to the requested adapter.
 *
 * @param input - Database, generation, requested adapter, path, and its owner.
 * @returns The owning adapter, or the requested adapter when the path is not indexed.
 * @throws {@link CodeIndexError} When the path belongs to another adapter.
 */
export const assertPathAdapter = (input: Readonly<{adapter: string | undefined; owner: string | null; path: string}>): void => {
	if (input.adapter !== undefined && input.owner !== null && input.owner !== input.adapter) {
		throw new CodeIndexError('adapter_path_mismatch', `Path ${input.path} belongs to adapter ${input.owner}, not ${input.adapter}`);
	}
};

/**
 * Requires one symbol to belong to the requested adapter.
 *
 * @param symbolAdapter - Adapter that owns the resolved symbol.
 * @param requested - Requested adapter filter, when present.
 * @throws {@link CodeIndexError} When the symbol belongs to another adapter.
 */
export const assertSymbolAdapter = (symbolAdapter: string, requested: string | undefined): void => {
	if (requested !== undefined && requested !== symbolAdapter) {
		throw new CodeIndexError('adapter_symbol_mismatch', `Symbol belongs to adapter ${symbolAdapter}, not ${requested}`);
	}
};
