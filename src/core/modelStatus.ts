import {
	type BuildLeaseType,
	type BuildStagesType,
	type BuildStatType,
	type GenerationStateType,
	type QueryFreshnessType,
	type RefreshStateType,
} from './model.ts';

export type IndexStatusType = Readonly<{
	readonly ready: boolean;
	readonly state: GenerationStateType | 'absent';
	readonly refresh: RefreshStateType;
	readonly generationId: string | null;
	/** Publication revision of the stable generation identifier. */
	readonly revision: number | null;
	readonly building: boolean;
	readonly scope: Readonly<{
		readonly root: string;
		readonly projectName: string;
		readonly projectFile: string;
		readonly projects: readonly Readonly<{readonly name: string; readonly projectFile: string; readonly adapter?: string | undefined}>[];
		/** One entry per configured adapter with persisted coverage and provenance. */
		readonly adapters: readonly Readonly<{
			readonly id: string;
			readonly version: string;
			readonly coverage: 'present' | 'absent';
			readonly absenceReason: string | null;
			readonly compilerVersion: string;
			readonly declaredCompilerVersion: string | null;
			readonly compilerDrift: boolean;
			readonly contexts: readonly string[];
			readonly limitations: readonly string[];
		}>[];
		/**
		 * Singular projection, present only when exactly one adapter is configured.
		 *
		 * A multi-adapter workspace must read `adapters`; one adapter's identity is
		 * never presented as a summary of several.
		 */
		readonly extractor?:
			| Readonly<{
					readonly id: string;
					readonly version: string;
					/** Runtime compiler or parser version. */
					readonly compilerVersion: string;
					/** Version declared by the project, when known. */
					readonly declaredCompilerVersion: string | null;
					/** True when the runtime and declared compiler majors differ. */
					readonly compilerDrift: boolean;
			  }>
			| undefined;
		readonly projectId: string;
		readonly workingCopyId: string | null;
	}>;
	readonly hashes: Readonly<{
		readonly source: string | null;
		readonly configuration: string | null;
	}>;
	readonly counts: Readonly<{
		readonly files: number;
		readonly symbols: number;
		readonly occurrences: number;
		readonly dependencyEdges: number;
		readonly dependencyBindings: number;
		readonly diagnostics: number;
	}>;
	readonly buildStats: readonly BuildStatType[];
	readonly build: Readonly<{
		readonly startedAt: string | null;
		readonly completedAt: string | null;
		readonly durationMs: number | null;
		readonly stages: BuildStagesType | null;
	}>;
	readonly freshness: QueryFreshnessType &
		Readonly<{
			readonly staleFiles: number;
			readonly sourceChanged: boolean | null;
		}>;
	readonly lease: BuildLeaseType | null;
	readonly exclusions: readonly string[];
	readonly lastError: string | null;
}>;

/** Bounded status projection for the default MCP response. */
export type IndexStatusSummaryType = Readonly<{
	readonly ready: boolean;
	readonly state: IndexStatusType['state'];
	readonly refresh: IndexStatusType['refresh'];
	readonly generationId: string | null;
	readonly revision: number | null;
	readonly building: boolean;
	readonly scope: Readonly<{
		readonly projectName: string;
		readonly contexts: readonly string[];
		/** One compact entry per configured adapter, when several exist or one is absent. */
		readonly adapters?:
			| readonly Readonly<{
					readonly id: string;
					readonly coverage: 'present' | 'absent';
					readonly absenceReason?: string | undefined;
					readonly contexts: readonly string[];
			  }>[]
			| undefined;
		/** Singular projection, present only when exactly one adapter is configured. */
		readonly extractor?: IndexStatusType['scope']['extractor'] | undefined;
	}>;
	readonly counts: IndexStatusType['counts'];
	readonly freshness: IndexStatusType['freshness'];
	readonly lastError: string | null;
}>;
