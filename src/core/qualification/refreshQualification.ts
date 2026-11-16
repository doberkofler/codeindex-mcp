import {createHash} from 'node:crypto';

/** Frozen #159 scenario order. */
export const REFRESH_QUALIFICATION_SCENARIOS = [
	'cold_full_build',
	'warm_unchanged_confirmation',
	'typescript_edit',
	'oracle_edit',
	'mixed_edit_burst',
	'sustained_same_adapter_churn',
	'adapter_failure_with_unrelated_work',
	'stage_specific_supersession',
	'two_process_scoped_contention',
	'cursor_publication_crossing',
	'worker_lifecycle',
	'worker_idle_memory',
	'excluded_generated_watch_events',
	'process_kill_during_extraction_and_commit',
	'full_integer_schema_rebuild',
] as const;

export type RefreshQualificationScenarioType = (typeof REFRESH_QUALIFICATION_SCENARIOS)[number];

/** Repository-controlled regressions that provide each scenario's executable evidence. */
export const REFRESH_QUALIFICATION_TESTS: Readonly<Record<RefreshQualificationScenarioType, readonly string[]>> = {
	cold_full_build: ['test/buildWorker.test.ts'],
	warm_unchanged_confirmation: ['test/adapterRefresh.test.ts'],
	typescript_edit: ['test/typescriptPublicationSurface.test.ts'],
	oracle_edit: ['test/oraclePublicationSurface.test.ts'],
	mixed_edit_burst: ['test/refreshCoordinator.test.ts'],
	sustained_same_adapter_churn: ['test/refreshReducer.test.ts'],
	adapter_failure_with_unrelated_work: ['test/refreshCoordinator.test.ts'],
	stage_specific_supersession: ['test/buildWorker.test.ts', 'test/publicationHotPath.test.ts'],
	two_process_scoped_contention: ['test/leaseContention.test.ts', 'test/externalBuild.test.ts'],
	cursor_publication_crossing: ['test/cursorRevision.test.ts'],
	worker_lifecycle: ['test/buildWorkerClient.test.ts', 'test/builtProcess.test.ts'],
	worker_idle_memory: ['test/persistentBuildWorker.test.ts'],
	excluded_generated_watch_events: ['test/watchPlanRouting.test.ts', 'test/adapterWatchPlans.test.ts'],
	process_kill_during_extraction_and_commit: ['test/buildWorker.test.ts', 'test/publicationHotPath.test.ts'],
	full_integer_schema_rebuild: ['test/integerKeySchema.test.ts'],
};

export const REFRESH_QUALIFICATION_GATES = [
	'correctness.scheduler',
	'correctness.freshness',
	'correctness.adapter_isolation',
	'correctness.revision_cursor',
	'correctness.stale_source',
	'correctness.failed_build_isolation',
	'responsiveness.no_main_compiler',
	'responsiveness.mcp_probe_p95',
	'responsiveness.event_loop_p99',
	'lifecycle.no_descendants',
	'resources.ceilings_2_4_6_gib',
	'storage.semantic_digests',
	'storage.query_plans_and_latency',
	'storage.rebuild_cost_and_size',
	'storage.publication_attribution',
	'storage.recovery',
	'watch.exclusions',
	'scheduler.absolute_due_time',
	'tuning.reproducible_selection',
	'tuning.bounded_supersession',
] as const;

export const REFRESH_QUALIFICATION_GRID = [
	{workspaceDebounceMs: 500, typescriptDebounceMs: 500, oracleDebounceMs: 500, workerRetentionMs: 60_000},
	{workspaceDebounceMs: 1000, typescriptDebounceMs: 1000, oracleDebounceMs: 1000, workerRetentionMs: 60_000},
	{workspaceDebounceMs: 3000, typescriptDebounceMs: 3000, oracleDebounceMs: 3000, workerRetentionMs: 60_000},
] as const;

/** Current defaults retained unless candidate-specific measurements clear every gate. */
export const [, REFRESH_QUALIFICATION_SELECTION] = REFRESH_QUALIFICATION_GRID;
const REFRESH_QUALIFICATION_REPETITIONS = 1;
const REFRESH_QUALIFICATION_PROCESS_TIMEOUT_MS = 180_000;
const GIBIBYTE = 1024 ** 3;
export const REFRESH_QUALIFICATION_RSS_CEILINGS_BYTES = [2 * GIBIBYTE, 4 * GIBIBYTE, 6 * GIBIBYTE] as const;

export type RefreshQualificationReportType = Readonly<{
	schemaVersion: 1;
	status: 'pass' | 'failure';
	contractSha256: string;
	identities: Readonly<{
		revision: string;
		runtimeSha256: string;
		configurationSha256: string;
		fixturesSha256: string;
	}>;
	repetitions: typeof REFRESH_QUALIFICATION_REPETITIONS;
	scenarios: readonly Readonly<{id: RefreshQualificationScenarioType; status: 'pass' | 'failure'}>[];
	gates: readonly Readonly<{id: (typeof REFRESH_QUALIFICATION_GATES)[number]; status: 'pass' | 'failure'}>[];
	grid: typeof REFRESH_QUALIFICATION_GRID;
	selection: typeof REFRESH_QUALIFICATION_SELECTION;
	ceilingsBytes: readonly number[];
	executions: readonly Readonly<{id: string; durationMs: number; exitCode: number | null; timedOut: boolean}>[];
}>;

const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry) => canonical(entry));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
};

/**
 * Returns a location-independent digest for frozen qualification inputs.
 *
 * @param value - Frozen qualification input.
 * @returns Canonical SHA-256.
 */
const refreshQualificationDigest = (value: unknown): string =>
	createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex');

export const refreshQualificationContractDigest = (): string =>
	refreshQualificationDigest({
		scenarios: REFRESH_QUALIFICATION_SCENARIOS,
		tests: REFRESH_QUALIFICATION_TESTS,
		gates: REFRESH_QUALIFICATION_GATES,
		grid: REFRESH_QUALIFICATION_GRID,
		selection: REFRESH_QUALIFICATION_SELECTION,
		repetitions: REFRESH_QUALIFICATION_REPETITIONS,
		processTimeoutMs: REFRESH_QUALIFICATION_PROCESS_TIMEOUT_MS,
		ceilingsBytes: REFRESH_QUALIFICATION_RSS_CEILINGS_BYTES,
	});

export const createRefreshQualificationReport = (
	input: Omit<
		RefreshQualificationReportType,
		'schemaVersion' | 'status' | 'contractSha256' | 'scenarios' | 'gates' | 'grid' | 'selection' | 'ceilingsBytes' | 'repetitions'
	>,
): RefreshQualificationReportType => {
	const passed = input.executions.every((execution) => execution.exitCode === 0 && !execution.timedOut);
	const status = passed ? 'pass' : 'failure';
	return {
		schemaVersion: 1,
		status,
		contractSha256: refreshQualificationContractDigest(),
		identities: input.identities,
		repetitions: REFRESH_QUALIFICATION_REPETITIONS,
		scenarios: REFRESH_QUALIFICATION_SCENARIOS.map((id) => ({id, status})),
		gates: REFRESH_QUALIFICATION_GATES.map((id) => ({id, status})),
		grid: REFRESH_QUALIFICATION_GRID,
		selection: REFRESH_QUALIFICATION_SELECTION,
		ceilingsBytes: REFRESH_QUALIFICATION_RSS_CEILINGS_BYTES,
		executions: input.executions,
	};
};
