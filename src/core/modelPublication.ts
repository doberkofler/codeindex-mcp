import {type DependencyConsumerItemType, type DependencyQueryMeaningType, type DependencyRootSummaryType, type QueryFreshnessType} from './model.ts';

export type SymbolSummaryType = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly kind: string;
	readonly path: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly enclosingId: string | null;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly contexts: readonly string[];
}>;

export type BindingExposureType = 'published' | 'reachable' | 'internal';

export type ContextExposureType = Readonly<{
	readonly contextName: string;
	readonly exposure: BindingExposureType;
}>;

export type BindingSiteKindType = 'declared' | 'alias' | 'default' | 'reexport' | 'wildcard' | 'commonjs' | 'surface';

export type BindingSiteSummaryType = Readonly<{
	readonly kind: BindingSiteKindType;
	readonly path: string;
	readonly start: number;
	readonly end: number;
}>;

export type DefinitionSiteSummaryType = Readonly<{
	readonly siteId: string;
	readonly path: string;
	readonly nameStart: number;
	readonly nameEnd: number;
	readonly extentStart: number;
	readonly extentEnd: number;
	readonly startLine: number;
	readonly endLine: number;
	readonly declarationKind: string;
	readonly forwardDefinition: boolean;
	readonly primary: boolean;
	readonly identityAnchor: boolean;
}>;

export type BindingSummaryType = Readonly<{
	readonly bindingId: string;
	readonly name: string;
	readonly container: string;
	readonly qualifiedName: string;
	readonly exposure: BindingExposureType;
	readonly inRequestedContext: boolean | null;
}>;

export type BindingDetailType = BindingSummaryType &
	Readonly<{
		readonly contexts: readonly ContextExposureType[];
		readonly contextsTotal: number;
		readonly contextsTruncated: boolean;
		readonly sites: readonly BindingSiteSummaryType[];
		readonly sitesTotal: number;
		readonly sitesTruncated: boolean;
	}>;

export type FindSymbolItemType = SymbolSummaryType &
	Readonly<{
		readonly symbolId: string;
		readonly symbolExposure: 'published' | 'reachable' | 'internal_only';
		readonly match: 'exact_qualified' | 'exact_name' | 'prefix_qualified' | 'prefix_name';
		readonly matched: BindingDetailType;
		readonly primary: BindingSummaryType;
		readonly otherNames: readonly BindingSummaryType[];
		readonly namesTotal: number;
		readonly namesTruncated: boolean;
		readonly sites: readonly DefinitionSiteSummaryType[];
		readonly sitesTotal: number;
		readonly sitesTruncated: boolean;
	}>;

type OutlineSymbolType = SymbolSummaryType &
	Readonly<{
		readonly site: DefinitionSiteSummaryType;
	}>;

export type OutlineReexportType = Readonly<{
	readonly bindingId: string;
	readonly symbolId: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly path: string;
	readonly start: number;
	readonly end: number;
	readonly kinds: readonly BindingSiteKindType[];
	readonly wildcardCount: number;
}>;

export type OutlineInputType = Readonly<{
	readonly path: string;
	readonly kinds?: readonly string[] | undefined;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

type PagedResultType<ItemType> = Readonly<{
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly items: readonly ItemType[];
	readonly nextCursor: string | null;
	readonly truncated: boolean;
}>;

export type OutlineResultType = PagedResultType<OutlineSymbolType> &
	Readonly<{
		readonly reexports: readonly OutlineReexportType[];
		readonly reexportsTotal: number;
		readonly reexportsTruncated: boolean;
	}>;

export type FindSymbolInputType = Readonly<{
	readonly query: string;
	readonly match?: 'name' | 'qualified' | undefined;
	readonly kind?: string | undefined;
	readonly container?: string | undefined;
	readonly path?: string | undefined;
	readonly context?: string | undefined;
	readonly exposure?: 'published' | 'reachable' | 'visible' | 'internal' | 'any' | undefined;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

export type FindSymbolResultType = PagedResultType<FindSymbolItemType> &
	Readonly<{
		readonly exposure: 'published' | 'reachable' | 'visible' | 'internal' | 'any';
		readonly match: 'name' | 'qualified';
	}>;

/** Presence bitmask for exact-name `find_symbol` matches. */
export type ExactNamePresenceType = 'none' | 'P' | 'R' | 'I' | 'PR' | 'PI' | 'RI' | 'PRI';

type ReferenceSelectorType = 'symbolId' | 'query';
export type ReferenceGroupModeType = 'file' | 'owner' | 'occurrence';

export type FindReferencesInputType = Readonly<{
	readonly symbolId?: string | undefined;
	readonly query?: string | undefined;
	readonly match?: 'name' | 'qualified' | undefined;
	readonly kind?: string | undefined;
	readonly container?: string | undefined;
	readonly exposure?: 'published' | 'reachable' | 'visible' | 'internal' | 'any' | undefined;
	readonly group?: ReferenceGroupModeType | undefined;
	readonly role?: 'definition' | 'reference' | undefined;
	readonly path?: string | undefined;
	readonly enclosingId?: string | undefined;
	readonly usage?: number | undefined;
	readonly context?: string | undefined;
	readonly limit: number;
	readonly cursor?: string | undefined;
}>;

export type ReferenceOwnerSummaryType = Readonly<{
	readonly symbolId: string;
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly startLine: number;
}>;

export type ReferenceType = Readonly<{
	readonly symbolId: string;
	readonly path: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly role: 'definition' | 'reference';
	readonly usage: number;
	readonly enclosingId: string | null;
	readonly owner: ReferenceOwnerSummaryType | null;
	readonly contexts: readonly string[];
}>;

type ReferenceCoverageType = Readonly<{
	readonly unclassifiedReferences: number;
	readonly crossFileRefsObserved: boolean;
}>;

type ReferenceTotalsType = Readonly<{
	readonly occurrencesTotal: number;
	readonly definitionsTotal: number;
}>;

/** One file or owner group of distinct occurrences. */
export type ReferenceGroupType = Readonly<{
	readonly path: string;
	readonly count: number;
	readonly usage: number;
	readonly contexts: readonly string[];
	readonly contextsTruncated: boolean;
}>;

/** One owner group; a null owner means top-level code in the path. */
export type ReferenceOwnerGroupType = ReferenceGroupType &
	Readonly<{
		readonly owner: ReferenceOwnerSummaryType | null;
	}>;

/** One compact symbol candidate returned for an ambiguous query. */
export type ReferenceCandidateType = Readonly<{
	readonly symbolId: string;
	readonly name: string;
	readonly qualifiedName: string;
	readonly kind: string;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly match: 'exact_qualified' | 'exact_name' | 'prefix_qualified' | 'prefix_name';
}>;

type FindReferencesBaseResultType = Readonly<{
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly selector: ReferenceSelectorType;
}>;

export type FindReferencesOccurrencesResultType = FindReferencesBaseResultType &
	PagedResultType<ReferenceType> &
	ReferenceCoverageType &
	ReferenceTotalsType &
	Readonly<{
		readonly kind: 'occurrences';
		readonly group: 'occurrence';
	}>;

type FindReferencesFilesResultType = FindReferencesBaseResultType &
	PagedResultType<ReferenceGroupType> &
	ReferenceCoverageType &
	ReferenceTotalsType &
	Readonly<{
		readonly kind: 'files';
		readonly group: 'file';
		readonly groupsTotal: number;
	}>;

type FindReferencesOwnersResultType = FindReferencesBaseResultType &
	PagedResultType<ReferenceOwnerGroupType> &
	ReferenceCoverageType &
	ReferenceTotalsType &
	Readonly<{
		readonly kind: 'owners';
		readonly group: 'owner';
		readonly groupsTotal: number;
	}>;

type FindReferencesAmbiguousResultType = FindReferencesBaseResultType &
	Readonly<{
		readonly kind: 'ambiguous';
		readonly selector: 'query';
		readonly candidates: readonly ReferenceCandidateType[];
		readonly candidatesTotal: number;
		readonly candidatesTruncated: boolean;
	}>;

type FindReferencesNoneResultType = FindReferencesBaseResultType &
	Readonly<{
		readonly kind: 'none';
		readonly selector: 'query';
		readonly reason: 'no_stored_match';
		readonly fallback: 'text_search';
		readonly message: string;
		readonly limitations: readonly string[];
	}>;

export type QueryFindReferencesResultType =
	| FindReferencesFilesResultType
	| FindReferencesOwnersResultType
	| FindReferencesAmbiguousResultType
	| FindReferencesNoneResultType;

export type FindReferencesResultType = FindReferencesOccurrencesResultType | QueryFindReferencesResultType;

export type SymbolIdFindReferencesInputType = FindReferencesInputType & Readonly<{symbolId: string; group?: 'occurrence' | undefined}>;

export type SymbolIdGroupedFindReferencesInputType = FindReferencesInputType & Readonly<{symbolId: string; group: 'file' | 'owner'}>;

export type SymbolIdGroupedFindReferencesResultType = FindReferencesFilesResultType | FindReferencesOwnersResultType;

export type QueryFindReferencesInputType = FindReferencesInputType & Readonly<{symbolId?: undefined; group?: 'file' | 'owner' | undefined}>;

export type FindDependenciesResultType = PagedResultType<DependencyConsumerItemType> &
	Readonly<{
		readonly queryMeaning: DependencyQueryMeaningType;
		readonly summary: Readonly<{
			readonly totalConsumers: number;
			readonly directConsumers: number;
			readonly transitiveConsumers: number;
			readonly roots: readonly DependencyRootSummaryType[];
		}>;
	}>;

export type ReadSymbolInputType = Readonly<{
	readonly symbolId?: string | undefined;
	readonly query?: string | undefined;
	readonly match?: 'name' | 'qualified' | undefined;
	readonly kind?: string | undefined;
	readonly container?: string | undefined;
	readonly path?: string | undefined;
	readonly exposure?: 'published' | 'reachable' | 'visible' | 'internal' | 'any' | undefined;
	readonly siteId?: string | undefined;
	readonly mode?: 'text' | 'sites' | 'names' | 'binding_sites' | 'binding_contexts' | undefined;
	readonly bindingId?: string | undefined;
	readonly context?: string | undefined;
	readonly contextLines: number;
	readonly limit?: number | undefined;
	readonly cursor?: string | undefined;
}>;

export type ReadSymbolTextResultType = Readonly<{
	readonly kind: 'text';
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly symbol: SymbolSummaryType;
	readonly site: DefinitionSiteSummaryType;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly source: string;
	readonly truncated: boolean;
	readonly truncatedReason: 'lines' | 'bytes' | null;
}>;

type ReadSymbolSitesResultType = PagedResultType<DefinitionSiteSummaryType> &
	Readonly<{
		readonly kind: 'sites';
	}>;

type ReadSymbolNamesResultType = PagedResultType<BindingSummaryType> &
	Readonly<{
		readonly kind: 'names';
	}>;

type ReadSymbolBindingSitesResultType = PagedResultType<BindingSiteSummaryType> &
	Readonly<{
		readonly kind: 'binding_sites';
		readonly bindingId: string;
	}>;

type ReadSymbolBindingContextsResultType = PagedResultType<ContextExposureType> &
	Readonly<{
		readonly kind: 'binding_contexts';
		readonly bindingId: string;
	}>;

type ReadSymbolAmbiguousResultType = Readonly<{
	readonly kind: 'ambiguous';
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly selector: 'query';
	readonly candidates: readonly ReferenceCandidateType[];
	readonly candidatesTotal: number;
	readonly candidatesTruncated: boolean;
}>;

type ReadSymbolNoneResultType = Readonly<{
	readonly kind: 'none';
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly selector: 'query';
	readonly reason: 'no_stored_match';
	readonly fallback: 'text_search';
	readonly message: string;
	readonly limitations: readonly string[];
}>;

export type ReadSymbolResultType =
	| ReadSymbolTextResultType
	| ReadSymbolSitesResultType
	| ReadSymbolNamesResultType
	| ReadSymbolBindingSitesResultType
	| ReadSymbolBindingContextsResultType
	| ReadSymbolAmbiguousResultType
	| ReadSymbolNoneResultType;

export type SymbolAtInputType = Readonly<{
	readonly path: string;
	readonly line: number;
	readonly column?: number | undefined;
}>;

type SymbolAtCandidateType = Readonly<{
	readonly symbol: SymbolSummaryType;
	readonly site: DefinitionSiteSummaryType;
}>;

export type SymbolAtResultType = Readonly<{
	readonly generationId: string;
	readonly freshness: QueryFreshnessType;
	readonly path: string;
	readonly line: number;
	readonly column: number | null;
	readonly candidates: readonly SymbolAtCandidateType[];
	readonly ambiguous: boolean;
	readonly ancestors: readonly SymbolSummaryType[];
	readonly reason: 'no_stored_owner' | null;
}>;
