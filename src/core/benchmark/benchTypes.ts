import {type BuildStagesType, type QueryFreshnessType} from '../model.ts';

export type BenchmarkPercentilesType = Readonly<{
	readonly count: number;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
	readonly p99Ms: number | null;
	readonly maxMs: number | null;
}>;

export type BenchmarkBuildType = Readonly<{
	readonly reused: boolean;
	readonly durationMs: number;
	readonly stages: BuildStagesType | null;
}>;

export type BenchmarkResourceType = Readonly<{
	readonly cpuUserMs: number;
	readonly cpuSystemMs: number;
	readonly rssStartBytes: number;
	readonly rssPeakBytes: number;
	readonly rssEndBytes: number;
	readonly lifetimeMaxRssBytes: number;
}>;

export type BenchmarkStorageType = Readonly<{
	readonly databaseBytes: number;
	readonly walBytes: number;
	readonly shmBytes: number;
	readonly totalBytes: number;
	readonly contentVersions: number;
	readonly extractionArtifacts: number;
}>;

export type BenchmarkReuseType = Readonly<{
	readonly generationReused: boolean;
	readonly filesTotal: number;
	readonly filesReused: number;
	readonly contentReuseRatio: number;
	readonly artifactRowsBefore: number;
	readonly artifactRowsAfter: number;
	readonly artifactRowsRead: number;
	readonly artifactReuseRatio: number;
	readonly artifactConsumption: 'not_implemented';
}>;

export type BenchmarkBuildScenarioType = Readonly<{
	readonly kind: 'build';
	readonly name: 'cold_build' | 'warm_reuse' | 'warm_rebuild';
	readonly wallMs: number;
	readonly generationId: string;
	readonly build: BenchmarkBuildType;
	readonly resources: BenchmarkResourceType;
	readonly storage: BenchmarkStorageType;
	readonly reuse: BenchmarkReuseType;
}>;

export type BenchmarkEditSampleType = Readonly<{
	readonly iteration: number;
	readonly latencyMs: number;
	readonly generationId: string;
}>;

export type BenchmarkEditScenarioType = Readonly<{
	readonly kind: 'edit';
	readonly name: 'edit_to_fresh';
	readonly wallMs: number;
	readonly rounds: number;
	readonly debounceMs: number;
	readonly samples: readonly BenchmarkEditSampleType[];
	readonly percentiles: BenchmarkPercentilesType;
	readonly build: BenchmarkBuildType | null;
	readonly resources: BenchmarkResourceType;
	readonly storage: BenchmarkStorageType;
	readonly reuse: BenchmarkReuseType;
}>;

export type BenchmarkCursorSampleType = Readonly<{
	readonly kind: 'outline' | 'find_symbol' | 'find_references';
	readonly depth: number;
	readonly limit: number;
	readonly elapsedMs: number;
	readonly plan: readonly string[];
	readonly usesIndex: boolean;
	readonly usesTempBTree: boolean;
}>;

export type BenchmarkCursorScenarioType = Readonly<{
	readonly kind: 'cursor';
	readonly name: 'deep_cursor';
	readonly wallMs: number;
	readonly maxDepth: number;
	readonly pageLimit: number;
	readonly samples: readonly BenchmarkCursorSampleType[];
	readonly resources: BenchmarkResourceType;
	readonly storage: BenchmarkStorageType;
}>;

export type BenchmarkScenarioResultType = BenchmarkBuildScenarioType | BenchmarkEditScenarioType | BenchmarkCursorScenarioType;

export type BenchmarkProfileType = 'small' | 'medium' | 'large' | 'xl';

export type BenchmarkWorkspaceType = Readonly<{
	readonly kind: 'generated' | 'external';
	readonly profile: BenchmarkProfileType | null;
	readonly projectId: string;
	readonly projectName: string;
	readonly fileCount: number;
	readonly symbolCount: number;
	readonly occurrenceCount: number;
	readonly dependencyEdgeCount: number;
	readonly sourceHash: string;
	readonly configHash: string;
}>;

export type BenchmarkMachineType = Readonly<{
	readonly nodeVersion: string;
	readonly platform: string;
	readonly arch: string;
	readonly cpuModel: string;
	readonly totalMemoryBytes: number;
}>;

export type BenchmarkReportType = Readonly<{
	readonly schemaVersion: 2;
	readonly generatedAt: string;
	readonly machine: BenchmarkMachineType;
	readonly runtime: Readonly<{
		readonly workerEntry: boolean;
		readonly scenariosInProcess: true;
	}>;
	readonly workspace: BenchmarkWorkspaceType;
	readonly iterations: number;
	readonly freshness: QueryFreshnessType;
	readonly scenarios: readonly BenchmarkScenarioResultType[];
	readonly queries: Readonly<Record<string, BenchmarkPercentilesType>>;
}>;

export type BenchmarkScenarioNameType = 'cold_build' | 'warm_reuse' | 'warm_rebuild' | 'edit_to_fresh' | 'deep_cursor';
