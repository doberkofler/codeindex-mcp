import {type IndexedSymbolType} from '../model.ts';
import {addressIssue, bindingIdentity} from './address.ts';
import {createFactId, serializeAddress} from './canonical.ts';
import {addIssue} from './issues.ts';
import {
	type ExtractedBindingType,
	type ExtractedFactSetType,
	type ExtractedOccurrenceType,
	type FactExposureType,
	type FactIssueType,
	type FactSiteKindType,
	type FinalizedBindingContextType,
	type FinalizedBindingSiteType,
} from './types.ts';

export type BindingEntryType = Readonly<{
	readonly binding: ExtractedBindingType;
	readonly bindingId: string;
	readonly bindingKey: string;
}>;

export type PendingSiteType = FinalizedBindingSiteType & Readonly<{readonly symbolId: string}>;

export type ContextCollectionType = Readonly<{
	readonly contexts: readonly FinalizedBindingContextType[];
	readonly exposuresByBinding: ReadonlyMap<string, readonly FactExposureType[]>;
}>;

export type SiteCollectionType = Readonly<{
	readonly sites: readonly PendingSiteType[];
	readonly sitesByBinding: ReadonlyMap<string, readonly PendingSiteType[]>;
}>;

export type BindingIdentityFactoryType = Readonly<{
	readonly binding: (symbolId: string, bindingKey: string) => string;
	readonly site: (symbolId: string, path: string, startOffset: number) => string;
}>;

const defaultIdentityFactory: BindingIdentityFactoryType = {
	binding: (symbolId, bindingKey) => createFactId('b_', [symbolId, bindingKey]),
	site: (symbolId, path, startOffset) => createFactId('o_', [symbolId, path, String(startOffset), 'definition']),
};

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const exposureRank = (exposure: FactExposureType): number => (exposure === 'published' ? 2 : exposure === 'reachable' ? 1 : 0);

const siteKindRank = (kind: FactSiteKindType): number =>
	kind === 'declared' ? 0 : kind === 'default' ? 1 : kind === 'alias' ? 2 : kind === 'reexport' ? 3 : kind === 'wildcard' ? 4 : kind === 'commonjs' ? 5 : 6;

/**
 * Looks up one canonical binding entry by symbol and address.
 *
 * @param entries - Canonical bindings.
 * @param symbolId - Symbol that owns the address.
 * @param segments - Address vector.
 * @returns The matching binding entry, or undefined.
 */
export const bindingIdFor = (
	entries: ReadonlyMap<string, BindingEntryType>,
	symbolId: string,
	segments: ExtractedBindingType['segments'],
): BindingEntryType | undefined => entries.get(bindingIdentity(symbolId, serializeAddress(segments)));

/**
 * Validates and derives canonical identity for every emitted binding.
 *
 * @param facts - Extracted fact bundle.
 * @param symbols - Validated symbols by identifier.
 * @param issues - Accumulated issues.
 * @param identities - Identifier derivation seam; production uses the canonical hash.
 * @returns Binding entries keyed by symbol and canonical binding key.
 */
export const collectBindings = (
	facts: ExtractedFactSetType,
	symbols: ReadonlyMap<string, IndexedSymbolType>,
	issues: FactIssueType[],
	identities: BindingIdentityFactoryType = defaultIdentityFactory,
): ReadonlyMap<string, BindingEntryType> => {
	const entries = new Map<string, BindingEntryType>();
	const bindingIds = new Map<string, string>();

	for (const binding of facts.bindings) {
		const invalid = addressIssue(binding.segments);

		if (invalid !== null) {
			addIssue(issues, 'invalid_address', invalid, {symbolId: binding.symbolId});
			continue;
		}

		if (!symbols.has(binding.symbolId)) {
			addIssue(issues, 'unknown_symbol', 'binding references an unknown symbol', {symbolId: binding.symbolId});
			continue;
		}

		const bindingKey = serializeAddress(binding.segments);
		const identity = bindingIdentity(binding.symbolId, bindingKey);

		if (entries.has(identity)) {
			addIssue(issues, 'duplicate_binding', 'one symbol emitted the same canonical binding more than once', {symbolId: binding.symbolId});
			continue;
		}

		const bindingId = identities.binding(binding.symbolId, bindingKey);
		const collided = bindingIds.get(bindingId);

		if (collided !== undefined && collided !== identity) {
			addIssue(issues, 'binding_id_collision', 'two binding identities produced the same 96-bit identifier', {
				symbolId: binding.symbolId,
				bindingId,
			});
			continue;
		}

		bindingIds.set(bindingId, identity);
		entries.set(identity, {binding, bindingId, bindingKey});
	}

	return entries;
};

/**
 * Maps emitted binding contexts onto canonical binding identifiers.
 *
 * @param facts - Extracted fact bundle.
 * @param entries - Canonical bindings.
 * @param issues - Accumulated issues.
 * @returns Context rows and their exposures by binding.
 */
export const collectContexts = (
	facts: ExtractedFactSetType,
	entries: ReadonlyMap<string, BindingEntryType>,
	issues: FactIssueType[],
): ContextCollectionType => {
	const rows: FinalizedBindingContextType[] = [];
	const exposuresByBinding = new Map<string, FactExposureType[]>();
	const seen = new Set<string>();

	for (const context of facts.bindingContexts) {
		const invalid = addressIssue(context.segments);

		if (invalid !== null) {
			addIssue(issues, 'invalid_address', invalid, {symbolId: context.symbolId});
			continue;
		}

		const entry = bindingIdFor(entries, context.symbolId, context.segments);

		if (entry === undefined) {
			addIssue(issues, 'orphan_binding_context', 'binding context references no emitted binding', {symbolId: context.symbolId});
			continue;
		}

		const key = `${entry.bindingId}\u0000${context.context}`;

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		rows.push({bindingId: entry.bindingId, context: context.context, exposure: context.exposure});
		const exposures = exposuresByBinding.get(entry.bindingId) ?? [];
		exposures.push(context.exposure);
		exposuresByBinding.set(entry.bindingId, exposures);
	}

	return {contexts: rows, exposuresByBinding};
};

/**
 * Maps emitted binding sites onto canonical binding identifiers.
 *
 * @param facts - Extracted fact bundle.
 * @param entries - Canonical bindings.
 * @param issues - Accumulated issues.
 * @param identities - Identifier derivation seam; production uses the canonical hash.
 * @returns Site rows grouped by binding.
 */
export const collectSites = (
	facts: ExtractedFactSetType,
	entries: ReadonlyMap<string, BindingEntryType>,
	issues: FactIssueType[],
	identities: BindingIdentityFactoryType = defaultIdentityFactory,
): SiteCollectionType => {
	const sites: PendingSiteType[] = [];
	const sitesByKey = new Map<string, PendingSiteType>();
	void identities;

	// One binding may own several canonical addresses projected from the same
	// authored site, so location identity must include the binding. Two bindings
	// sharing a symbol and source offset still each retain their own site.
	for (const site of facts.bindingSites) {
		const invalid = addressIssue(site.segments);

		if (invalid !== null) {
			addIssue(issues, 'invalid_address', invalid, {symbolId: site.symbolId});
			continue;
		}

		const entry = bindingIdFor(entries, site.symbolId, site.segments);

		if (entry === undefined) {
			addIssue(issues, 'orphan_binding_site', 'binding site references no emitted binding', {symbolId: site.symbolId});
			continue;
		}

		const location = `${entry.bindingId}\u0000${site.path}\u0000${String(site.range.startOffset)}`;
		const existing = sitesByKey.get(location);

		if (existing !== undefined && siteKindRank(existing.kind) <= siteKindRank(site.kind)) {
			continue;
		}

		const row: PendingSiteType = {bindingId: entry.bindingId, kind: site.kind, path: site.path, range: site.range, symbolId: site.symbolId};
		sitesByKey.set(location, row);
	}

	for (const row of sitesByKey.values()) {
		sites.push(row);
	}

	const sitesByBinding = new Map<string, PendingSiteType[]>();

	for (const row of sites) {
		const group = sitesByBinding.get(row.bindingId) ?? [];
		group.push(row);
		sitesByBinding.set(row.bindingId, group);
	}

	return {sites, sitesByBinding};
};

// Returns the strongest exposure in one context list.
export const bindingExposureOf = (exposures: readonly FactExposureType[]): FactExposureType => {
	let selected: FactExposureType = 'internal';

	for (const exposure of exposures) {
		if (exposureRank(exposure) > exposureRank(selected)) {
			selected = exposure;
		}
	}

	return selected;
};

/**
 * Selects a primary binding for one symbol.
 *
 * @param primary - Primary definition occurrence.
 * @param entriesForSymbol - Candidate bindings.
 * @param sitesByBinding - Sites grouped by binding.
 * @returns The selected binding, or null.
 */
export const primaryBindingOf = (
	primary: ExtractedOccurrenceType | null,
	entriesForSymbol: readonly BindingEntryType[],
	sitesByBinding: ReadonlyMap<string, readonly PendingSiteType[]>,
): BindingEntryType | null => {
	const candidates = [...entriesForSymbol];
	const primaryRange =
		primary === null
			? null
			: {
					startLine: primary.startLine,
					startColumn: primary.startColumn,
					endLine: primary.endLine,
					endColumn: primary.endColumn,
					startOffset: primary.startOffset,
					endOffset: primary.endOffset,
				};

	const score = (entry: BindingEntryType): readonly [number, number, string, string] => {
		const sites = sitesByBinding.get(entry.bindingId) ?? [];
		const hasDeclared = sites.some((site) => site.kind === 'declared') ? 0 : 1;
		const matchesPrimary =
			primaryRange !== null &&
			sites.some(
				(site) =>
					(site.kind === 'declared' || site.kind === 'default') &&
					site.range.startOffset === primaryRange.startOffset &&
					site.range.endOffset === primaryRange.endOffset,
			);

		return [matchesPrimary ? 0 : 1, hasDeclared, entry.bindingKey, entry.bindingId];
	};

	candidates.sort((left, right) => {
		const leftScore = score(left);
		const rightScore = score(right);

		return leftScore[0] - rightScore[0] || leftScore[1] - rightScore[1] || compareText(leftScore[2], rightScore[2]) || compareText(leftScore[3], rightScore[3]);
	});

	return candidates[0] ?? null;
};

/**
 * Groups canonical bindings by symbol.
 *
 * @param entries - Canonical bindings.
 * @returns Binding entries grouped by symbol identifier.
 */
export const groupBindingsBySymbol = (entries: ReadonlyMap<string, BindingEntryType>): ReadonlyMap<string, readonly BindingEntryType[]> => {
	const groups = new Map<string, BindingEntryType[]>();

	for (const entry of entries.values()) {
		const group = groups.get(entry.binding.symbolId) ?? [];
		group.push(entry);
		groups.set(entry.binding.symbolId, group);
	}

	return groups;
};
