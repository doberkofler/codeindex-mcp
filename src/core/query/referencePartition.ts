import {type IndexDatabase} from '../storage/database.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {
	type ReferenceCompletenessType,
	type ReferencePartitionMemberType,
	type ReferencePartitionScopeType,
	type ReferencePartitionType,
	type SymbolSummaryType,
} from '../model.ts';

/** Maximum members listed in one response; totals remain complete. */
const MAX_PARTITION_MEMBERS = 20;

export type ResolvedReferencePartitionType = Readonly<{
	/** Every symbol identifier in the selected partition, seed included. */
	readonly symbolIds: readonly string[];
	readonly partition: ReferencePartitionType;
}>;

const memberOf = (symbol: SymbolSummaryType): ReferencePartitionMemberType => ({
	symbolId: symbol.id,
	name: symbol.name,
	kind: symbol.kind,
	adapter: symbol.adapter,
	path: symbol.path,
	startLine: symbol.startLine,
});

/**
 * Derives completeness from stored definitions, never from drop counters.
 *
 * A member without a stored definition cannot prove that its occurrences were
 * fully extracted, so the selected partition is reported as bounded. A
 * definition-preserving extraction reports complete.
 *
 * @param database - Published index reader.
 * @param generationId - Published generation.
 * @param symbolIds - Symbols in the selected partition.
 * @returns `complete` only when every member has a stored definition.
 */
const completenessOf = (database: IndexDatabase, generationId: string, symbolIds: readonly string[]): ReferenceCompletenessType => {
	const definitions = database.definitionCountsBySymbol(generationId, symbolIds);

	return symbolIds.every((symbolId) => (definitions.get(symbolId) ?? 0) > 0) ? 'complete' : 'bounded';
};

type PartitionInputType = Readonly<{
	readonly database: IndexDatabase;
	readonly generationId: string;
	readonly scope: ReferencePartitionScopeType;
	readonly seed: SymbolSummaryType;
	readonly members: readonly SymbolSummaryType[];
	readonly externalTarget: string | null;
	readonly externalName: string | null;
}>;

const partitionOf = (input: PartitionInputType): ResolvedReferencePartitionType => {
	const symbolIds = input.members.map((member) => member.id);
	const memberSymbols = input.members.map((member) => memberOf(member));
	const siblings = memberSymbols.filter((member) => member.symbolId !== input.seed.id);

	return {
		symbolIds,
		partition: {
			scope: input.scope,
			externalTarget: input.externalTarget,
			externalName: input.externalName,
			memberSymbols: memberSymbols.slice(0, MAX_PARTITION_MEMBERS),
			siblingSymbols: siblings.slice(0, MAX_PARTITION_MEMBERS),
			memberSymbolsTotal: memberSymbols.length,
			siblingSymbolsTotal: siblings.length,
			membersTruncated: memberSymbols.length > MAX_PARTITION_MEMBERS || siblings.length > MAX_PARTITION_MEMBERS,
			completeness: completenessOf(input.database, input.generationId, symbolIds),
		},
	};
};

/**
 * Resolves the selected reference partition without changing occurrence identity.
 *
 * The default partition contains exactly the requested symbol. The external
 * alias group contains every stored symbol with the same external target and
 * name, seeded by the requested symbol; it never fans one occurrence out to
 * several symbols and never includes direct external call sites.
 *
 * @param database - Published index reader.
 * @param generationId - Published generation.
 * @param symbolId - Requested seed symbol.
 * @param options - Requested partition selector and optional adapter filter.
 * @returns Partition identifiers and response metadata.
 * @throws {@link CodeIndexError} When an alias group is requested for an
 * authored symbol that has no external target and name.
 */
export const resolveReferencePartition = (
	database: IndexDatabase,
	generationId: string,
	symbolId: string,
	options: Readonly<{scope: ReferencePartitionScopeType | undefined; adapter?: string | undefined}>,
): ResolvedReferencePartitionType => {
	const {scope, adapter} = options;
	const seed = database.getSymbol(generationId, symbolId);

	if (seed === null) {
		throw new CodeIndexError(
			'symbol_not_found',
			`Unknown symbol: ${symbolId}. Symbol IDs are opaque; copy one from find_symbol or outline instead of constructing it.`,
		);
	}

	if (scope !== 'external_alias_group') {
		return partitionOf({
			database,
			generationId,
			scope: 'partition',
			seed,
			members: [seed],
			externalTarget: seed.externalTarget ?? null,
			externalName: seed.externalName ?? null,
		});
	}

	const group = database.externalAliasGroup(generationId, symbolId, adapter);

	if (group === null) {
		throw new CodeIndexError(
			'invalid_argument',
			`scope: external_alias_group requires an indexed external alias. ${symbolId} has no external module target and imported name; use scope: partition.`,
		);
	}

	return partitionOf({
		database,
		generationId,
		scope: 'external_alias_group',
		seed,
		members: group.members,
		externalTarget: group.externalTarget,
		externalName: group.externalName,
	});
};
