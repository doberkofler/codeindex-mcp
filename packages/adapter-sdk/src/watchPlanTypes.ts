/** Current serializable watch-plan representation. */
export const ADAPTER_WATCH_PLAN_VERSION = 1;

/**
 * One language-neutral path matcher selected by an adapter.
 *
 * Paths and patterns use workspace-relative POSIX spelling. The host executes
 * these generic operations but does not infer language or project semantics.
 */
export type AdapterWatchRuleType =
	| Readonly<{readonly kind: 'glob'; readonly pattern: string}>
	| Readonly<{readonly kind: 'prefix'; readonly path: string}>
	| Readonly<{readonly kind: 'suffix'; readonly suffix: string}>
	| Readonly<{readonly kind: 'segment'; readonly segment: string; readonly ignoreCase?: boolean | undefined}>;

/** One independently matched project/configuration scope in a watch plan. */
export type AdapterWatchScopeType = Readonly<{
	/** Workspace-relative directories recursively containing possible sources. */
	readonly candidateRoots: readonly string[];
	/** Adapter-owned project inclusion semantics. */
	readonly includeRules: readonly AdapterWatchRuleType[];
	/** Adapter-owned project and generated-source exclusions. */
	readonly excludeRules: readonly AdapterWatchRuleType[];
	/** Adapter-owned authored-source classification. */
	readonly sourceRules: readonly AdapterWatchRuleType[];
}>;

/**
 * Serializable adapter-owned filesystem watch plan.
 *
 * No absolute path may occur in this shape. `planId` identifies the normalized
 * plan contents, while `planVersion` identifies the representation.
 */
export type AdapterWatchPlanType = Readonly<{
	readonly adapterId: string;
	readonly adapterVersion: string;
	readonly planVersion: number;
	readonly planId: string;
	/** Exact authored files from the authoritative scan. */
	readonly knownSourceFiles: readonly string[];
	/** Exact configuration and discovered non-source inputs. */
	readonly inputFiles: readonly string[];
	readonly scopes: readonly AdapterWatchScopeType[];
}>;
