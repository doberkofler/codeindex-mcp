import {
	type AdapterStatType,
	type ExtractedOccurrenceType,
	type FactAddressType,
	type FactExposureType,
	type FactRangeType,
	type FactSiteKindType,
	type IndexedSymbolType,
	type SymbolExposureType,
} from '../types.ts';

export type {
	AdapterStatType,
	ExtractedBindingContextType,
	ExtractedBindingSiteType,
	ExtractedBindingType,
	ExtractedFactSetType,
	ExtractedOccurrenceType,
	ExtractedPublicationFactsType,
	ExtractedSurfaceOriginType,
	FactAddressSegmentType,
	FactAddressType,
	FactExposureType,
	FactRangeType,
	FactSiteKindType,
	SymbolExposureType,
} from '../types.ts';

/** Finalization may report violations or fail the candidate generation. */
type FinalizationModeType = 'enforce' | 'report';

/** Language-neutral finalization controls, including the mandatory safety ceiling. */
export type FinalizationPolicyType = Readonly<{
	readonly mode: FinalizationModeType;
	/** Maximum surface bindings below one published root. */
	readonly maxBindingsPerRoot: number;
	/**
	 * Adapter identity for extractor-specific measured invariants.
	 *
	 * When present, S3, O2, L1, and F1 are measured during finalization and
	 * reported as issues. `enforce` mode fails the candidate on any violation.
	 */
	readonly extractorId?: string | undefined;
}>;

/** Stable category for one finalization violation. */
export type FactIssueCodeType =
	| 'duplicate_symbol'
	| 'unknown_symbol'
	| 'invalid_address'
	| 'duplicate_binding'
	| 'binding_id_collision'
	| 'site_id_collision'
	| 'orphan_binding_context'
	| 'orphan_binding_site'
	| 'invalid_surface_origin'
	| 'missing_binding_context'
	| 'missing_binding_site'
	| 'missing_definition'
	| 'ceiling_exceeded'
	| 'invariant_s3'
	| 'invariant_o2'
	| 'invariant_l1'
	| 'invariant_f1';

/** One finalization violation without source text or absolute paths. */
export type FactIssueType = Readonly<{
	readonly code: FactIssueCodeType;
	readonly message: string;
	readonly symbolId: string | null;
	readonly bindingId: string | null;
}>;

/** Derived binding fields shared by contexts, sites, and query modules. */
export type FinalizedBindingType = Readonly<{
	readonly bindingId: string;
	readonly symbolId: string;
	readonly bindingKey: string;
	readonly segments: FactAddressType;
	readonly container: string;
	readonly name: string;
	readonly qualifiedName: string;
	/** Strongest exposure across every project context that contains the binding. */
	readonly exposure: FactExposureType;
	/** Whether a declared or default source site introduces the binding. */
	readonly hasDeclaredSite: boolean;
}>;

export type FinalizedBindingContextType = Readonly<{
	readonly bindingId: string;
	readonly context: string;
	readonly exposure: FactExposureType;
}>;

export type FinalizedBindingSiteType = Readonly<{
	readonly bindingId: string;
	readonly kind: FactSiteKindType;
	readonly path: string;
	readonly range: FactRangeType;
}>;

export type FinalizedSurfaceOriginType = Readonly<{
	readonly bindingId: string;
	readonly context: string;
	readonly rootBindingId: string;
	readonly rootKey: string;
	readonly relativeKey: string;
}>;

/** Symbol with the fields derived from its definitions and bindings. */
export type FinalizedSymbolType = IndexedSymbolType &
	Readonly<{
		readonly exposure: SymbolExposureType;
		readonly primaryDefinitionSiteId: string;
		readonly primaryBindingId: string | null;
	}>;

/** Aggregate counts derived from one extracted fact bundle. */
export type FinalizationStatsType = Readonly<{
	readonly symbols: number;
	readonly bindings: number;
	readonly bindingContexts: number;
	readonly bindingSites: number;
	readonly surfaceOrigins: number;
	readonly occurrences: number;
	readonly definitions: number;
	readonly references: number;
	readonly publishedSymbols: number;
	readonly reachableSymbols: number;
	readonly internalOnlySymbols: number;
	readonly publishedBindings: number;
	readonly reachableBindings: number;
	readonly internalBindings: number;
	readonly maxBindingsPerSymbol: number;
	readonly maxSurfaceBindingsPerRoot: number;
}>;

/** Complete derived fact set persisted by one generation build. */
export type FinalizedFactSetType = Readonly<{
	readonly symbols: readonly FinalizedSymbolType[];
	readonly bindings: readonly FinalizedBindingType[];
	readonly bindingContexts: readonly FinalizedBindingContextType[];
	readonly bindingSites: readonly FinalizedBindingSiteType[];
	readonly surfaceOrigins: readonly FinalizedSurfaceOriginType[];
	readonly occurrences: readonly ExtractedOccurrenceType[];
	readonly adapterStats: readonly AdapterStatType[];
	readonly stats: FinalizationStatsType;
	readonly issues: readonly FactIssueType[];
}>;
