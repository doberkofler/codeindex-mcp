import {type BuildFailureCauseType} from '../generation/buildFailureCause.ts';
import {type BuildStagesType, type IndexStatusType} from '../model.ts';
import {type BenchmarkPercentilesType, type BenchmarkProfileType} from './benchTypes.ts';
import {type BenchmarkCorpusCountsType} from './corpus.ts';

/** Version of the operational soak report. */
export const SOAK_SCHEMA_VERSION = 1 as const;

/** One real file write in a soak event. */
export type SoakEditType = Readonly<{
	path: string;
	beforeSha256: string;
	afterSha256: string;
	contentChanged: boolean;
}>;

/** Kind of deterministic edit event applied by the soak runner. */
export type SoakEventKindType = 'single' | 'burst' | 'stale-probe';

/** Retained storage counters for one observation point. */
export type SoakStorageType = Readonly<{
	generations: number;
	contentVersions: number;
	extractionArtifacts: number;
	databaseBytes: number;
	walBytes: number;
	shmBytes: number;
	totalBytes: number;
}>;

/** Resource usage sampled while one soak event completed. */
export type SoakResourceType = Readonly<{
	cpuUserMs: number;
	cpuSystemMs: number;
	rssStartBytes: number;
	rssPeakBytes: number;
	rssEndBytes: number;
}>;

/** One completed edit event and its edit-to-fresh measurement. */
export type SoakEventType = Readonly<{
	sequence: number;
	kind: SoakEventKindType;
	edits: readonly SoakEditType[];
	startedAt: string;
	freshAt: string;
	eventToFreshMs: number;
	generationId: string;
	/** True when at least one write happened while the previous refresh was building. */
	overlappedBuild: boolean;
	/** True when a write arrived during a refresh and required one follow-up build. */
	coalesced: boolean;
	build: Readonly<{durationMs: number; stages: BuildStagesType | null}> | null;
	resources: SoakResourceType;
	storage: SoakStorageType;
}>;

/** One build failure observed by the soak, including injected and burst-induced failures. */
export type SoakBuildFailureType = Readonly<{
	cause: BuildFailureCauseType;
	detail: string;
	injected: boolean;
	recovered: boolean;
}>;

/** One injected build failure and its unattended recovery. */
export type SoakFailureType = Readonly<{
	cause: BuildFailureCauseType;
	injected: 'source-read';
	detail: string;
	publishedGenerationBefore: string | null;
	publishedGenerationAfter: string | null;
	publicationPreserved: boolean;
	queriesServedWhileFailed: boolean;
	recovered: boolean;
	recoveryMs: number;
	manualIntervention: boolean;
}>;

/** One clean index restart and the generation it reused. */
export type SoakRestartType = Readonly<{
	index: number;
	generationBefore: string | null;
	generationAfter: string | null;
	reused: boolean;
	sameGeneration: boolean;
	durationMs: number;
}>;

/** Stale-source refusal observed before the watcher rebuilds. */
export type SoakStaleRefusalType = Readonly<{
	path: string;
	beforeSha256: string;
	afterSha256: string;
	contentChanged: boolean;
	refused: boolean;
	errorCode: string | null;
	eventToFreshMs: number;
	generationId: string;
}>;

/** One retention observation while the soak runs. */
export type SoakRetentionObservationType = Readonly<{
	sequence: number;
	generations: number;
	contentVersions: number;
	extractionArtifacts: number;
	databaseBytes: number;
	totalBytes: number;
}>;

/** Declared retention policy and the observations it bounds. */
export type SoakRetentionType = Readonly<{
	policy: Readonly<{
		publishedGenerations: 1;
		supersededGenerations: 1;
		contentVersionsPerGeneration: number;
		extractionArtifactsPerContentVersion: 2;
	}>;
	observations: readonly SoakRetentionObservationType[];
	maxima: Readonly<{
		generations: number;
		contentVersions: number;
		extractionArtifacts: number;
		databaseBytes: number;
	}>;
	bounds: Readonly<{
		generations: number;
		contentVersions: number;
		extractionArtifacts: number;
	}>;
	satisfied: boolean;
}>;

/** One model-free acceptance gate for the operational soak. */
export type SoakGateType = Readonly<{
	id: string;
	result: 'pass' | 'fail';
	detail: string;
}>;

/** Input plan for one deterministic soak run. */
export type SoakPlanType = Readonly<{
	profile: BenchmarkProfileType;
	rounds: number;
	burstEdits: number;
	failures: number;
	restarts: number;
	debounceMs: number;
	timeoutMs: number;
}>;

/** Complete sanitized operational soak report. */
export type SoakReportType = Readonly<{
	recordType: 'operational-soak';
	schemaVersion: typeof SOAK_SCHEMA_VERSION;
	planHash: string;
	editScriptHash: string;
	generatedAt: string;
	machine: Readonly<{
		nodeVersion: string;
		platform: string;
		arch: string;
		cpuModel: string;
		cpuCount: number;
		memoryBytes: number;
	}>;
	runtime: Readonly<{workerEntry: boolean; watch: true; analytics: boolean}>;
	workspace: Readonly<{
		profile: BenchmarkProfileType;
		fileCount: number;
		symbolCount: number;
		expected: BenchmarkCorpusCountsType;
	}>;
	plan: SoakPlanType & Readonly<{targetPaths: readonly string[]}>;
	coldBuild: Readonly<{
		durationMs: number;
		generationId: string;
		files: number;
		symbols: number;
		resources: SoakResourceType;
		storage: SoakStorageType;
	}>;
	events: readonly SoakEventType[];
	latency: BenchmarkPercentilesType;
	failures: readonly SoakFailureType[];
	buildFailures: readonly SoakBuildFailureType[];
	failureCauses: Readonly<Partial<Record<BuildFailureCauseType, number>>>;
	recovery: Readonly<{
		injectedFailures: number;
		recoveredFailures: number;
		manualInterventions: number;
		automatic: boolean;
	}>;
	staleRefusal: SoakStaleRefusalType | null;
	restarts: readonly SoakRestartType[];
	retention: SoakRetentionType;
	resources: SoakResourceType;
	freshness: IndexStatusType['freshness'] | null;
	gates: readonly SoakGateType[];
	passed: boolean;
	blocking: readonly string[];
}>;
