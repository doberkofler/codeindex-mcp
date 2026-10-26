import os from 'node:os';
import path from 'node:path';
import {realpathSync, rmSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {type ConfigType} from '../config/config.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type BenchmarkProfileType} from './benchTypes.ts';
import {benchmarkCorpusCounts, prepareBenchmarkWorkspace} from './corpus.ts';
import {type BenchmarkEditProgressType} from './editScenario.ts';
import {summarize} from './percentiles.ts';
import {startResourceSampler} from './resources.ts';
import {injectFailureOf, restartOf, runBurstEvent, runSingleEvent, staleProbeOf} from './soakEvents.ts';
import {gatesOf, type SoakReportBaseType} from './soakGates.ts';
import {
	databaseDirectoryOf,
	editScriptHashOf,
	failureCausesOf,
	observationOf,
	openState,
	planHashOf,
	retentionOf,
	runSequential,
	storageOf,
	waitFor,
	EDIT_TARGETS,
	FAILURE_TARGET,
	STALE_TARGET,
	type SoakStateType,
} from './soakSupport.ts';
import {
	SOAK_SCHEMA_VERSION,
	type SoakEventType,
	type SoakFailureType,
	type SoakPlanType,
	type SoakReportType,
	type SoakRestartType,
	type SoakResourceType,
	type SoakRetentionObservationType,
	type SoakStaleRefusalType,
} from './soakTypes.ts';

export type SoakRunOptionsType = Readonly<{
	config: ConfigType;
	profile: BenchmarkProfileType;
	plan: SoakPlanType;
	logger: LoggerType;
	workspace?: string | undefined;
	workerEntry?: string | undefined;
	/** Integration tests may run without the packaged build worker. */
	requireBuildOverlap?: boolean;
	onProgress?: ((progress: BenchmarkEditProgressType) => void) | undefined;
}>;

type SoakRunResultType = Readonly<{report: SoakReportType; workspace: string; databaseDirectory: string; temporaryWorkspace: boolean}>;

/** Hard bound so a misconfigured duration can never run without end. */
const DURATION_EVENT_LIMIT = 100_000;

const reportOf = (
	input: Readonly<{
		state: SoakStateType;
		plan: SoakPlanType;
		workerEntry: boolean;
		overall: SoakResourceType;
		cold: SoakReportType['coldBuild'];
		events: readonly SoakEventType[];
		elapsedMs: number;
		idle: SoakReportType['idle'];
		failures: readonly SoakFailureType[];
		staleRefusal: SoakStaleRefusalType | null;
		restarts: readonly SoakRestartType[];
		observations: readonly SoakRetentionObservationType[];
		requireBuildOverlap: boolean;
	}>,
): SoakReportType => {
	const status = input.state.index.getStatus();
	const base: SoakReportBaseType = {
		recordType: 'operational-soak',
		schemaVersion: SOAK_SCHEMA_VERSION,
		planHash: planHashOf(input.plan, [...EDIT_TARGETS, STALE_TARGET, FAILURE_TARGET]),
		editScriptHash: editScriptHashOf(input.plan),
		generatedAt: new Date().toISOString(),
		machine: {
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			cpuModel: os.cpus().at(0)?.model ?? 'unknown',
			cpuCount: os.cpus().length,
			memoryBytes: os.totalmem(),
		},
		runtime: {workerEntry: input.workerEntry, watch: true, analytics: false},
		workspace: {
			profile: input.plan.profile,
			fileCount: status.counts.files,
			symbolCount: status.counts.symbols,
			expected: benchmarkCorpusCounts(input.plan.profile),
		},
		plan: {...input.plan, targetPaths: [...EDIT_TARGETS, STALE_TARGET, FAILURE_TARGET]},
		coldBuild: input.cold,
		events: input.events,
		elapsedMs: input.elapsedMs,
		latency: summarize(input.events.map((event) => event.eventToFreshMs)),
		failures: input.failures,
		buildFailures: input.state.observedFailures,
		failureCauses: failureCausesOf(input.state.observedFailures),
		recovery: {
			injectedFailures: input.plan.failures,
			recoveredFailures: input.failures.filter((failure) => failure.recovered).length,
			manualInterventions: input.failures.filter((failure) => failure.manualIntervention).length,
			automatic: input.failures.every((failure) => failure.recovered && !failure.manualIntervention),
		},
		staleRefusal: input.staleRefusal,
		restarts: input.restarts,
		retention: retentionOf({observations: input.observations, fileCount: status.counts.files}),
		idle: input.idle,
		resources: input.overall,
		freshness: status.freshness,
	};
	const gates = gatesOf(base, input.requireBuildOverlap);
	const blocking = gates.filter((gate) => gate.result === 'fail').map((gate) => gate.id);

	return {...base, gates, passed: blocking.length === 0, blocking};
};

const pushEvent = (
	input: Readonly<{
		events: SoakEventType[];
		observations: SoakRetentionObservationType[];
		event: SoakEventType;
		total: number;
		state: SoakStateType;
		onProgress?: ((progress: BenchmarkEditProgressType) => void) | undefined;
	}>,
): void => {
	const {event, events, observations, state} = input;

	events.push(event);
	observations.push(observationOf(event.sequence, state.database, state.config.databasePath));
	input.onProgress?.({iteration: events.length, rounds: input.total, latencyMs: event.eventToFreshMs, etaMs: 0});
};

const runEventsOf = async (
	state: SoakStateType,
	observations: SoakRetentionObservationType[],
	onProgress: ((progress: BenchmarkEditProgressType) => void) | undefined,
): Promise<readonly SoakEventType[]> => {
	const events: SoakEventType[] = [];
	const total = state.plan.rounds + 2;
	const deadline = state.plan.durationMs > 0 ? performance.now() + state.plan.durationMs : null;

	// Recursion rather than a loop: every edit must publish before the next one
	// starts, so the sequence is a chain of dependent awaits.
	const singleEvent = async (): Promise<void> => {
		const event = await runSingleEvent(state, events.length + 1);
		pushEvent({events, observations, event, total, state, onProgress});

		const belowMinimum = events.length < state.plan.rounds;
		const insideDuration = deadline !== null && performance.now() < deadline && events.length < DURATION_EVENT_LIMIT;

		if (belowMinimum || insideDuration) {
			await singleEvent();
		}
	};

	await singleEvent();

	const burst = await runBurstEvent(state, events.length + 1);

	pushEvent({events, observations, event: burst, total, state, onProgress});

	return events;
};

const idleOf = async (state: SoakStateType, windowMs: number): Promise<SoakReportType['idle']> => {
	if (windowMs === 0) {
		return null;
	}

	await waitFor({
		attempt: () => {
			const status = state.index.getStatus();
			return status.refresh === 'current' && !status.building && status.lastError === null ? true : null;
		},
		timeoutMs: state.plan.timeoutMs,
		label: 'idle reconciliation',
	});

	const bucketMs = 1000;
	const buckets = Math.max(1, Math.floor(windowMs / bucketMs));
	const cpuStart = process.cpuUsage();
	const samplesPercent: number[] = [];
	let lastUser = 0;
	let lastSystem = 0;

	const recordBucket = async (): Promise<void> => {
		await delay(bucketMs);
		const cpu = process.cpuUsage(cpuStart);
		samplesPercent.push(Math.round(((cpu.user - lastUser + (cpu.system - lastSystem)) / 1000 / bucketMs) * 100 * 1000) / 1000);
		lastUser = cpu.user;
		lastSystem = cpu.system;
	};

	await Array.from({length: buckets}).reduce<Promise<void>>(async (previous) => {
		await previous;
		await recordBucket();
	}, Promise.resolve());

	const cpuUserMs = Math.round(lastUser / 1000);
	const cpuSystemMs = Math.round(lastSystem / 1000);
	const measuredMs = buckets * bucketMs;
	const averagePercent = Math.round(((lastUser + lastSystem) / 1000 / measuredMs) * 100 * 1000) / 1000;
	const sorted = [...samplesPercent].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const medianPercent = sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : Math.round((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2) * 1000) / 1000;

	return {windowMs: measuredMs, cpuUserMs, cpuSystemMs, averagePercent, medianPercent, samplesPercent};
};

const initialWorkspaceOf = (options: SoakRunOptionsType): Readonly<{rootDir: string; temporary: boolean}> => {
	const prepared = prepareBenchmarkWorkspace({profile: options.profile, workspace: options.workspace});
	const rootDir = prepared.workspaceRoot ?? options.config.rootDir;

	return {rootDir, temporary: prepared.temporaryWorkspace !== null};
};

const baseConfigOf = (options: SoakRunOptionsType, workspaceRoot: string, databaseDirectory: string): ConfigType => {
	// resolveConfig canonicalizes the root; the soak must do the same. Otherwise
	// scanned source paths keep the temporary-directory spelling (`/var/...`)
	// while config files resolve to their real path (`/private/var/...`), and the
	// watcher silently drops every event that arrives with the other spelling.
	const rootDir = realpathSync(workspaceRoot);

	return {
		...options.config,
		projectName: `soak-${options.profile}`,
		rootDir,
		projectFilePath: path.join(rootDir, 'tsconfig.json'),
		projects: [{name: 'root', projectFilePath: path.join(rootDir, 'tsconfig.json')}],
		databasePath: path.join(databaseDirectory, 'index.sqlite'),
		analyticsEnabled: false,
		analyticsPath: path.join(databaseDirectory, 'analytics.jsonl'),
	};
};

/**
 * Executes one deterministic operational soak with real files, the real
 * watcher, and the real builder.
 *
 * The plan is fixed before the first write. Every event appends deterministic
 * source text, waits for watcher-driven publication, and records freshness,
 * CPU, RSS, storage, and retention. Failure injection replaces one source file
 * with a directory, then restores it and waits for unattended recovery.
 *
 * @param options - Base configuration, plan, logger, workspace, and runtime entry points.
 * @returns The sanitized report and the paths that own the generated data.
 */
export const runSoak = async (options: SoakRunOptionsType): Promise<SoakRunResultType> => {
	const workspace = initialWorkspaceOf(options);
	const databaseDirectory = databaseDirectoryOf();
	const config = baseConfigOf(options, workspace.rootDir, databaseDirectory);
	const overall = startResourceSampler();
	const coldSampler = startResourceSampler();
	let state = openState({
		config,
		plan: options.plan,
		logger: options.logger,
		watch: true,
		requireBuildOverlap: options.requireBuildOverlap ?? true,
		...(options.workerEntry === undefined ? {} : {workerEntry: options.workerEntry}),
	});
	const observations: SoakRetentionObservationType[] = [];

	try {
		const coldStartedAt = performance.now();
		const coldReport = await state.index.ensureReady({force: true});
		const cold: SoakReportType['coldBuild'] = {
			durationMs: Math.round(performance.now() - coldStartedAt),
			generationId: coldReport.generationId,
			files: coldReport.fileCount,
			symbols: coldReport.symbolCount,
			resources: coldSampler.stop(),
			storage: storageOf(state.database, config.databasePath),
		};

		state.index.start();
		await delay(options.plan.debounceMs + 100);
		await waitFor({
			attempt: () => (state.index.getStatus().refresh === 'current' ? true : null),
			timeoutMs: options.plan.timeoutMs,
			label: 'initial watcher refresh',
		});
		observations.push(observationOf(0, state.database, config.databasePath));

		const eventsStartedAt = performance.now();
		const events = [...(await runEventsOf(state, observations, options.onProgress))];
		const elapsedMs = Math.round(performance.now() - eventsStartedAt);
		const stale = await staleProbeOf(state, events.length + 1);
		events.push(stale.event);
		observations.push(observationOf(events.length, state.database, config.databasePath));

		const failures = await runSequential(options.plan.failures, async (index) => {
			const failure = await injectFailureOf(state);
			observations.push(observationOf(events.length + index + 1, state.database, config.databasePath));
			return failure;
		});
		const restarts = await runSequential(options.plan.restarts, async (index) => {
			const restarted = await restartOf(state, index + 1, options.logger);
			const {state: nextState, restart} = restarted;
			state = nextState;
			observations.push(observationOf(events.length + failures.length + index + 1, state.database, config.databasePath));
			return restart;
		});

		// Suspend RSS polling: its resident-memory syscall is CPU work and would be
		// charged to an otherwise idle index.
		overall.pause();
		const idle = await idleOf(state, options.plan.idleSampleMs);
		overall.resume();

		const report = reportOf({
			state,
			plan: options.plan,
			workerEntry: options.workerEntry !== undefined,
			overall: overall.stop(),
			cold,
			events,
			elapsedMs,
			idle,
			failures,
			staleRefusal: stale.stale,
			restarts,
			observations,
			requireBuildOverlap: options.requireBuildOverlap ?? true,
		});

		return {report, workspace: workspace.rootDir, databaseDirectory, temporaryWorkspace: workspace.temporary};
	} finally {
		overall.stop();
		coldSampler.stop();

		try {
			await state.index.close();
		} catch {
			// Closing after a recorded failure must not hide the report.
		}
	}
};

/**
 * Removes the generated database and, when generated, the workspace after a report is written.
 *
 * @param run - Paths returned by {@link runSoak}.
 */
export const removeSoakWorkspace = (run: Readonly<{workspace: string; databaseDirectory: string; temporaryWorkspace: boolean}>): void => {
	rmSync(run.databaseDirectory, {recursive: true, force: true});

	if (run.temporaryWorkspace) {
		rmSync(run.workspace, {recursive: true, force: true});
	}
};
