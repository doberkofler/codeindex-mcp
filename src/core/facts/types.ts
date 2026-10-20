import {type DependencyExtractionResultType, type DiagnosticType, type IndexedOccurrenceType, type IndexedSymbolType, type SourceFileType} from '../model.ts';

/** Source range carried by one declaration or binding site. */
export type FactRangeType = Readonly<{
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly startOffset: number;
	readonly endOffset: number;
}>;

/**
 * One typed address segment.
 *
 * Adapters choose the legal kinds and values for their language. The core
 * validates only the generic tuple shape and serializes the vector.
 */
export type FactAddressSegmentType = readonly [kind: string, value: string | number | null];

/** Ordered address segments for one searchable binding. */
export type FactAddressType = readonly FactAddressSegmentType[];

/** Exposure of one binding in one project context. */
export type FactExposureType = 'published' | 'reachable' | 'internal';

/** Exposure derived for a symbol from all of its binding contexts. */
export type SymbolExposureType = 'published' | 'reachable' | 'internal_only';

/** Source form that introduced one binding. */
export type FactSiteKindType = 'declared' | 'alias' | 'default' | 'reexport' | 'wildcard' | 'commonjs' | 'surface';

/** Adapter-defined aggregate statistic. */
type AdapterStatType = Readonly<{
	readonly metric: string;
	readonly value: number;
	readonly dimensions?: readonly string[] | undefined;
}>;

/**
 * Definition occurrence enriched with the ranking and extent inputs owned by an
 * adapter.
 *
 * Reference occurrences leave every optional field absent. The core finalizer
 * selects one identity anchor and one primary definition per symbol from these
 * fields.
 */
export type ExtractedOccurrenceType = IndexedOccurrenceType &
	Readonly<{
		/** Declaration form at this definition occurrence. */
		readonly declarationKind?: string | undefined;
		readonly forwardDefinition?: boolean | undefined;
		/** Declaration extent, which may be wider than the name range. */
		readonly extent?: FactRangeType | undefined;
		readonly anchorRank?: number | undefined;
		readonly primaryRank?: number | undefined;
	}>;

/** One searchable binding before the core derives its canonical key and ID. */
export type ExtractedBindingType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
}>;

/** Exposure of one binding in one project context. */
export type ExtractedBindingContextType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly context: string;
	readonly exposure: FactExposureType;
}>;

/** One authored source site that introduces or projects a binding. */
export type ExtractedBindingSiteType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly kind: FactSiteKindType;
	readonly path: string;
	readonly range: FactRangeType;
}>;

/**
 * Published root and relative address path for one surface binding.
 *
 * The moved address is validated against `rootSegments + relativeSegments`.
 */
export type ExtractedSurfaceOriginType = Readonly<{
	readonly symbolId: string;
	readonly segments: FactAddressType;
	readonly context: string;
	readonly rootSymbolId: string;
	readonly rootSegments: FactAddressType;
	readonly relativeSegments: FactAddressType;
}>;

/** Binding facts emitted by one adapter for one generation. */
export type ExtractedPublicationFactsType = Readonly<{
	readonly bindings: readonly ExtractedBindingType[];
	readonly bindingContexts: readonly ExtractedBindingContextType[];
	readonly bindingSites: readonly ExtractedBindingSiteType[];
	readonly surfaceOrigins: readonly ExtractedSurfaceOriginType[];
}>;

/**
 * Complete serializable fact bundle crossing the adapter seam.
 *
 * Compiler and parser objects never appear in this shape. Existing persistence
 * consumes `files`, `symbols`, `occurrences`, `dependencies`, and `diagnostics`
 * unchanged while the publication facts remain report-only.
 */
export type ExtractedFactSetType = Readonly<{
	readonly files: readonly SourceFileType[];
	readonly symbols: readonly IndexedSymbolType[];
	readonly bindings: readonly ExtractedBindingType[];
	readonly bindingContexts: readonly ExtractedBindingContextType[];
	readonly bindingSites: readonly ExtractedBindingSiteType[];
	readonly surfaceOrigins: readonly ExtractedSurfaceOriginType[];
	readonly occurrences: readonly ExtractedOccurrenceType[];
	readonly dependencies: DependencyExtractionResultType;
	readonly adapterStats: readonly AdapterStatType[];
	readonly diagnostics: readonly DiagnosticType[];
	readonly compilerMs: number;
	readonly extractionMs: number;
}>;

/** Finalization may report violations or fail the candidate generation. */
type FinalizationModeType = 'enforce' | 'report';

/** Language-neutral finalization controls, including the mandatory safety ceiling. */
export type FinalizationPolicyType = Readonly<{
	readonly mode: FinalizationModeType;
	/** Maximum surface bindings below one published root. */
	readonly maxBindingsPerRoot: number;
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
	| 'ceiling_exceeded';

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
}>;

export type FinalizedBindingContextType = Readonly<{
	readonly bindingId: string;
	readonly context: string;
	readonly exposure: FactExposureType;
}>;

export type FinalizedBindingSiteType = Readonly<{
	readonly siteId: string;
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

/** Complete derived fact set. Existing persistence does not consume this shape yet. */
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
