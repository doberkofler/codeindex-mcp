import {type IndexedSymbolType} from '../model.ts';
import {collectBindings, collectContexts, collectSites, groupBindingsBySymbol, type BindingEntryType, type PendingSiteType} from './bindings.ts';
import {compareFactText, displayBinding} from './canonical.ts';
import {assertPolicy, addIssue} from './issues.ts';
import {measurePublicationInvariants, type PublicationInvariantKindType} from './measuredInvariants.ts';
import {collectOrigins} from './origins.ts';
import {finalizationStatsOf} from './stats.ts';
import {finalizeSymbols} from './symbols.ts';
import {
	type ExtractedFactSetType,
	type ExtractedOccurrenceType,
	type FactExposureType,
	type FactIssueType,
	type FinalizationPolicyType,
	type FinalizedBindingContextType,
	type FinalizedBindingSiteType,
	type FinalizedBindingType,
	type FinalizedFactSetType,
	type FinalizedSurfaceOriginType,
} from './types.ts';

const groupDefinitions = (occurrences: readonly ExtractedOccurrenceType[]): ReadonlyMap<string, readonly ExtractedOccurrenceType[]> => {
	const groups = new Map<string, ExtractedOccurrenceType[]>();

	for (const occurrence of occurrences) {
		if (occurrence.role !== 'definition') {
			continue;
		}

		const group = groups.get(occurrence.symbolId) ?? [];
		group.push(occurrence);
		groups.set(occurrence.symbolId, group);
	}

	return groups;
};

const strongestExposure = (exposures: readonly FactExposureType[] | undefined): FactExposureType => {
	let selected: FactExposureType = 'internal';

	for (const exposure of exposures ?? []) {
		if (exposure === 'published') {
			return 'published';
		}

		if (exposure === 'reachable') {
			selected = 'reachable';
		}
	}

	return selected;
};

const hasDeclaredSite = (sites: readonly PendingSiteType[] | undefined): boolean =>
	(sites ?? []).some((site) => site.kind === 'declared' || site.kind === 'default');

const bindingRowsOf = (
	entries: ReadonlyMap<string, BindingEntryType>,
	exposuresByBinding: ReadonlyMap<string, readonly FactExposureType[]>,
	sitesByBinding: ReadonlyMap<string, readonly PendingSiteType[]>,
): readonly FinalizedBindingType[] =>
	[...entries.values()]
		.map((entry) => {
			const display = displayBinding(entry.binding.segments);

			return {
				bindingId: entry.bindingId,
				symbolId: entry.binding.symbolId,
				bindingKey: entry.bindingKey,
				segments: entry.binding.segments,
				container: display.container,
				name: display.name,
				qualifiedName: display.qualifiedName,
				exposure: strongestExposure(exposuresByBinding.get(entry.bindingId)),
				hasDeclaredSite: hasDeclaredSite(sitesByBinding.get(entry.bindingId)),
			};
		})
		.sort(
			(left, right) =>
				compareFactText(left.symbolId, right.symbolId) ||
				compareFactText(left.bindingKey, right.bindingKey) ||
				compareFactText(left.bindingId, right.bindingId),
		);

const sortContexts = (contexts: readonly FinalizedBindingContextType[]): readonly FinalizedBindingContextType[] =>
	[...contexts].sort((left, right) => compareFactText(left.context, right.context) || compareFactText(left.bindingId, right.bindingId));

const sortSites = (sites: readonly PendingSiteType[]): readonly FinalizedBindingSiteType[] =>
	[...sites]
		.map(({symbolId: _symbolId, ...site}) => site)
		.sort(
			(left, right) =>
				compareFactText(left.path, right.path) ||
				left.range.startOffset - right.range.startOffset ||
				left.range.endOffset - right.range.endOffset ||
				compareFactText(left.kind, right.kind) ||
				compareFactText(left.bindingId, right.bindingId),
		);

const sortOrigins = (origins: readonly FinalizedSurfaceOriginType[]): readonly FinalizedSurfaceOriginType[] =>
	[...origins].sort(
		(left, right) =>
			compareFactText(left.rootBindingId, right.rootBindingId) ||
			compareFactText(left.bindingId, right.bindingId) ||
			compareFactText(left.context, right.context),
	);

const sortOccurrences = (occurrences: readonly ExtractedOccurrenceType[]): readonly ExtractedOccurrenceType[] =>
	[...occurrences].sort(
		(left, right) =>
			compareFactText(left.path, right.path) ||
			left.startOffset - right.startOffset ||
			compareFactText(left.symbolId, right.symbolId) ||
			compareFactText(left.role, right.role),
	);

const sortAdapterStats = (stats: ExtractedFactSetType['adapterStats']): ExtractedFactSetType['adapterStats'] =>
	[...stats].sort(
		(left, right) =>
			compareFactText(left.metric, right.metric) ||
			compareFactText((left.dimensions ?? []).join('\u0000'), (right.dimensions ?? []).join('\u0000')) ||
			left.value - right.value,
	);

const collectSymbols = (symbols: readonly IndexedSymbolType[], issues: FactIssueType[]): ReadonlyMap<string, IndexedSymbolType> => {
	const map = new Map<string, IndexedSymbolType>();

	for (const symbol of symbols) {
		if (map.has(symbol.id)) {
			addIssue(issues, 'duplicate_symbol', 'generation emitted the same symbol identifier twice', {symbolId: symbol.id});
			continue;
		}

		map.set(symbol.id, symbol);
	}

	return map;
};

const assertBindingCoverage = (
	entries: ReadonlyMap<string, BindingEntryType>,
	exposuresByBinding: ReadonlyMap<string, readonly unknown[]>,
	sitesByBinding: ReadonlyMap<string, readonly unknown[]>,
	issues: FactIssueType[],
): void => {
	for (const entry of entries.values()) {
		if (!exposuresByBinding.has(entry.bindingId)) {
			addIssue(issues, 'missing_binding_context', 'binding has no project-context exposure', {
				symbolId: entry.binding.symbolId,
				bindingId: entry.bindingId,
			});
		}

		if (!sitesByBinding.has(entry.bindingId)) {
			addIssue(issues, 'missing_binding_site', 'binding has no source site', {
				symbolId: entry.binding.symbolId,
				bindingId: entry.bindingId,
			});
		}
	}
};

const invariantIssueCode = (invariant: PublicationInvariantKindType): 'invariant_s3' | 'invariant_o2' | 'invariant_l1' | 'invariant_f1' =>
	invariant === 'S3' ? 'invariant_s3' : invariant === 'O2' ? 'invariant_o2' : invariant === 'L1' ? 'invariant_l1' : 'invariant_f1';

const addInvariantIssues = (issues: FactIssueType[], extractorId: string, facts: ExtractedFactSetType, finalized: FinalizedFactSetType): void => {
	const measured = measurePublicationInvariants(facts, finalized, extractorId);

	for (const violation of [measured.s3, measured.o2, measured.l1, measured.f1].flatMap((summary) => summary.violations)) {
		addIssue(issues, invariantIssueCode(violation.invariant), `${violation.invariant} ${violation.class}`, {
			symbolId: violation.symbolId,
			bindingId: violation.bindingId,
		});
	}
};

/**
 * Finalizes one serializable adapter fact bundle.
 *
 * The finalizer owns deterministic ordering, canonical binding keys, derived
 * identifiers, exposure aggregation, primary/anchor selection, structural
 * invariants, and safety ceilings. It does not interpret language semantics.
 *
 * In `report` mode violations are returned and remain non-fatal. A safety
 * ceiling overrun aborts both modes because a truncated report or generation is
 * never valid. When `extractorId` is present, measured invariants S3, O2, L1,
 * and F1 are enforced with the other finalization issues.
 *
 * @param facts - Adapter-emitted serializable facts.
 * @param policy - Mode, extractor identity, and mandatory finite safety ceiling.
 * @returns Derived facts, aggregate statistics, and any violations.
 * @throws {@link Error} On invalid policy, duplicate/colliding identities, a
 * ceiling overrun, or an enforced measured-invariant violation.
 */
export const finalizeFacts = (facts: ExtractedFactSetType, policy: FinalizationPolicyType): FinalizedFactSetType => {
	assertPolicy(policy);
	const issues: FactIssueType[] = [];
	const symbols = collectSymbols(facts.symbols, issues);
	const entries = collectBindings(facts, symbols, issues);
	const entriesBySymbol = groupBindingsBySymbol(entries);
	const definitionsBySymbol = groupDefinitions(facts.occurrences);
	const {contexts, exposuresByBinding} = collectContexts(facts, entries, issues);
	const {sites, sitesByBinding} = collectSites(facts, entries, issues);
	const {origins, maxSurfaceBindingsPerRoot} = collectOrigins(facts, entries, policy, issues);
	const finalizedSymbols = finalizeSymbols({
		symbols: [...symbols.values()],
		definitionsBySymbol,
		entriesBySymbol,
		exposuresByBinding,
		sitesByBinding,
		issues,
	});

	assertBindingCoverage(entries, exposuresByBinding, sitesByBinding, issues);

	const finalBindings = bindingRowsOf(entries, exposuresByBinding, sitesByBinding);
	const finalContexts = sortContexts(contexts);
	const finalSites = sortSites(sites);
	const finalOrigins = sortOrigins(origins);
	const finalOccurrences = sortOccurrences(facts.occurrences);
	const candidate: FinalizedFactSetType = {
		symbols: finalizedSymbols,
		bindings: finalBindings,
		bindingContexts: finalContexts,
		bindingSites: finalSites,
		surfaceOrigins: finalOrigins,
		occurrences: finalOccurrences,
		adapterStats: sortAdapterStats(facts.adapterStats),
		stats: finalizationStatsOf({
			facts,
			entries,
			symbols: finalizedSymbols,
			bindings: finalBindings,
			contexts: finalContexts,
			sites,
			origins: finalOrigins,
			maxSurfaceBindingsPerRoot,
		}),
		issues,
	};

	if (policy.extractorId !== undefined) {
		addInvariantIssues(issues, policy.extractorId, facts, candidate);
	}

	const ceilingIssues = issues.filter((issue) => issue.code === 'ceiling_exceeded');

	if (ceilingIssues.length > 0) {
		throw new Error(`Publication fact report is incomplete: ${ceilingIssues.map((issue) => issue.message).join('; ')}`);
	}

	if (policy.mode === 'enforce' && issues.length > 0) {
		const [first] = issues;
		throw new Error(`Publication fact finalization failed with ${String(issues.length)} violation(s): ${first?.code ?? 'unknown'}: ${first?.message ?? ''}`);
	}

	return candidate;
};
