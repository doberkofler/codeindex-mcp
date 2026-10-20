type MeasurementStatusType = 'measured' | 'partial' | 'blocked';

export type DistributionType = Readonly<{
	readonly total: number;
	readonly buckets: Readonly<Record<string, number>>;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly max: number;
}>;

export type ViolationSummaryType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly checked: number;
	readonly violations: number;
	readonly classes: Readonly<Record<string, number>>;
	readonly note?: string | undefined;
}>;

export type M1ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly nestedFunctions: number;
	readonly totalLines: number;
	readonly p95ExtentLines: number;
	readonly maxExtentLines: number;
}>;

export type M2ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly javascriptFiles: number;
	readonly commonJsFiles: number;
	readonly esmJavaScriptFiles: number;
	readonly unclassifiedJavaScriptFiles: number;
}>;

export type M4ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly definitionOccurrences: number;
	readonly definitionSites: number;
	readonly symbolsWithMultipleBindings: number;
	readonly bindingsPerSymbol: DistributionType;
	readonly sitesPerBinding: DistributionType;
}>;

export type M6ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly surfaceAddressesPerRoot: DistributionType;
	readonly reachabilityStepsPerRoot: DistributionType;
	readonly runtimeMs: number;
	readonly peakRssBytes: number;
	readonly note?: string | undefined;
}>;

export type M7ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly routinePairs: number | null;
	readonly cursorPairs: number | null;
	readonly callSpecs: number | null;
	readonly polymorphicTableFunctions: number | null;
	readonly ambiguityRatePpm: number | null;
	readonly overloadGroups: number | null;
	readonly bodyForwards: number | null;
	readonly bodyLessSpec: number | null;
	readonly unclassifiedBodyLessSpec: number | null;
	readonly note?: string | undefined;
}>;

export type M11ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly maximumReachabilityStepsPerRoot: number;
	readonly proposedCeiling: number | null;
	readonly headroomFactor: number | null;
	readonly headroomTargetFactor: number;
	readonly headroomStatus: 'blocked_on_projection' | 'computed';
	readonly note?: string | undefined;
}>;

export type M12ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly maximumSurfaceBindingsPerRoot: number;
	readonly maximumSurfaceBindingsPerSymbol: number;
	readonly proposedCeiling: number | null;
	readonly headroomFactor: number | null;
	readonly headroomTargetFactor: number;
	readonly headroomStatus: 'blocked_on_projection' | 'computed';
	readonly anonymous: number;
	readonly inherited: number;
	readonly depth1: number;
	readonly note?: string | undefined;
}>;

export type M13ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly unionCases: number;
	readonly intersectionCases: number;
	readonly selectedSemantics: 'constituent_projection' | 'constituent_reachability' | 'undecided';
	readonly note?: string | undefined;
}>;

export type M14ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly mergedSymbols: number;
	readonly kindsets: Readonly<Record<string, number>>;
	readonly proposedPrecedence: readonly string[];
	readonly kindChangesUnderProposedPrecedence: number;
	readonly note?: string | undefined;
}>;

export type R1ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly symbolsByExposureAndKind: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly occurrencesByRole: Readonly<Record<string, number>>;
	readonly usageStatus: 'not_emitted';
	readonly occurrencesByOwner: Readonly<Record<'null' | 'present', Record<'definition' | 'reference', number>>>;
	readonly sourceLinesRepresented: number;
}>;

export type R2ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly s3: ViolationSummaryType;
	readonly o2: ViolationSummaryType;
	readonly l1: ViolationSummaryType;
	readonly f1: ViolationSummaryType;
}>;

export type P1ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly contexts: number;
	readonly emittedFiles: number;
	readonly declarationMapFiles: number;
	readonly emitErrors: number;
	readonly emittedModules: number;
	readonly mappedModules: number;
	readonly unmappedModules: number;
	readonly emittedExports: number;
	readonly publishedRoots: number;
	readonly missingPublishedRoots: number;
	readonly extraPublishedRoots: number;
	readonly gA: 'partial' | 'passed' | 'failed';
	readonly gA2: 'partial' | 'passed' | 'failed';
	readonly note?: string | undefined;
}>;

export type P2ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly modules: number;
	readonly namedExternalAliases: number;
	readonly namespaceExternalAliases: number;
	readonly defaultExternalAliases: number;
	readonly externalStars: number;
	readonly commonJsModules: number;
	readonly exportEqualsModules: number;
	readonly exportEqualsIdentifierNames: number;
	readonly exportEqualsExpressions: number;
	readonly missingPublishedAliases: number;
	readonly missingPublishedAliasesByKind: Readonly<Record<string, number>>;
	readonly note?: string | undefined;
}>;

export type P3ReportType = Readonly<{
	readonly status: MeasurementStatusType;
	readonly roots: number;
	readonly completedRoots: number;
	readonly budgetExceededRoots: number;
	readonly depthLimitedRoots: number;
	readonly surfaceAddresses: number;
	readonly reachabilitySteps: number;
	readonly surfaceAddressesPerRoot: DistributionType;
	readonly reachabilityStepsPerRoot: DistributionType;
	readonly maximumSurfaceAddressesPerRoot: number;
	readonly maximumReachabilityStepsPerRoot: number;
	readonly maximumSurfaceAddressesPerSymbol: number;
	readonly anonymousAddresses: number;
	readonly inheritedAddresses: number;
	readonly depthOneAddresses: number;
	readonly runtimeMs: number;
	readonly note?: string | undefined;
}>;

type PublicationPrototypeReportType = Readonly<{
	readonly p1: P1ReportType | null;
	readonly p2: P2ReportType | null;
	readonly p3: P3ReportType | null;
}>;

export type PublicationMeasurementsType = Readonly<{
	readonly m1: M1ReportType;
	readonly m2: M2ReportType;
	readonly m4: M4ReportType;
	readonly m6: M6ReportType;
	readonly m7: M7ReportType;
	readonly m11: M11ReportType;
	readonly m12: M12ReportType;
	readonly m13: M13ReportType;
	readonly m14: M14ReportType;
	readonly r1: R1ReportType;
	readonly r2: R2ReportType;
}>;

export type PublicationReportType = Readonly<{
	readonly schemaVersion: 1;
	readonly tool: 'publication-report';
	readonly runtime: Readonly<{
		readonly scanMs: number;
		readonly compilerMs: number;
		readonly extractionMs: number;
		readonly finalizationMs: number;
		readonly totalMs: number;
		readonly peakRssBytes: number;
	}>;
	readonly workspace: Readonly<{
		readonly projectId: string;
		readonly contexts: readonly string[];
		readonly fileCount: number;
		readonly sourceLineCount: number;
		readonly sourceHash: string;
		readonly configHash: string;
		readonly excludedFileCount: number;
	}>;
	readonly extractor: Readonly<{
		readonly id: string;
		readonly version: string;
		readonly compilerVersion: string;
		readonly declaredCompilerVersion: string | null;
		readonly compilerDrift: boolean;
	}>;
	readonly facts: Readonly<{
		readonly files: number;
		readonly symbols: number;
		readonly occurrences: number;
		readonly definitions: number;
		readonly references: number;
		readonly bindings: number;
		readonly bindingContexts: number;
		readonly bindingSites: number;
		readonly surfaceOrigins: number;
		readonly dependencyEdges: number;
		readonly dependencyBindings: number;
	}>;
	readonly exposure: Readonly<{
		readonly publishedSymbols: number;
		readonly reachableSymbols: number;
		readonly internalOnlySymbols: number;
		readonly publishedBindings: number;
		readonly reachableBindings: number;
		readonly internalBindings: number;
	}>;
	readonly measurements: PublicationMeasurementsType;
	readonly prototypes: PublicationPrototypeReportType;
	readonly issues: Readonly<{
		readonly total: number;
		readonly byCode: Readonly<Record<string, number>>;
	}>;
	readonly telemetry: Readonly<{
		readonly status: 'not_collected';
		readonly counters: Readonly<Record<string, number>>;
	}>;
	readonly limitations: readonly string[];
}>;

type PublicationDiagnosticExampleType = Readonly<{
	readonly class: string;
	readonly path: string;
	readonly startOffset: number;
	readonly symbolId: string;
	readonly bindingId: string | null;
}>;

export type PublicationDiagnosticArtifactType = Readonly<{
	readonly schemaVersion: 1;
	readonly projectId: string;
	readonly contexts: readonly string[];
	readonly groups: readonly Readonly<{
		readonly invariant: 'S3' | 'O2' | 'L1' | 'F1';
		readonly class: string;
		readonly count: number;
		readonly examples: readonly PublicationDiagnosticExampleType[];
	}>[];
	readonly truncated: boolean;
}>;
