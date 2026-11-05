import {appendFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {type AdapterProbeResultType, type AdapterType} from '@codeindex/adapter-sdk';
import {loadConfiguredAdapters} from '../../adapters/loader.ts';
import {type ConfigType} from '../config/config.ts';
import {createCodeIndex} from '../generation/codeIndex.ts';
import {createLogger} from '../logging/logger.ts';
import {type IndexStatusType, type QueryFreshnessType} from '../model.ts';
import {processTreeRssBytes} from '../resources/processTree.ts';
import {IndexDatabase} from '../storage/database.ts';
import {databaseBytesOf, type PreparedMultiAdapterWorkspaceType} from './multiAdapterCorpus.ts';
import {
	activityCountersOf,
	addCounters,
	adapterIdOf,
	MultiAdapterRecorder,
	numberField,
	type AdapterIdType,
	type RecordedEventType,
	zeroCounters,
} from './multiAdapterRecorder.ts';
import {summarize} from './percentiles.ts';
import {startResourceSampler} from './resources.ts';
import {benchmarkConfigOf} from './runBenchmark.ts';
import {
	type AdapterCountersType,
	type MultiAdapterEditSampleType,
	type MultiAdapterIsolationRoundType,
	type MultiAdapterReportType,
	type MultiAdapterSupersessionType,
} from './multiAdapterTypes.ts';

const LOGGER = createLogger({minimumLevel: 'error'});
const POLL_INTERVAL_MS = 5;
const TREE_SAMPLE_INTERVAL_MS = 100;
const CHURN_BUILD_TIMEOUT_MS = 3000;

type CounterStateType = Record<AdapterIdType, AdapterCountersType>;

type TotalsType = Record<AdapterIdType, Record<AdapterIdType, AdapterCountersType>>;

type RoundAccumulatorType = {
	readonly samples: MultiAdapterEditSampleType[];
	readonly isolationRounds: MultiAdapterIsolationRoundType[];
	readonly totals: TotalsType;
};

type BenchmarkIndexType = Readonly<{index: ReturnType<typeof createCodeIndex>}>;

const waitFor = async <ValueType>(
	input: Readonly<{
		attempt: () => ValueType | null;
		timeoutMs: number;
		label: string;
	}>,
): Promise<ValueType> => {
	const deadline = performance.now() + input.timeoutMs;
	const poll = async (): Promise<ValueType> => {
		const value = input.attempt();

		if (value !== null) {
			return value;
		}

		if (performance.now() >= deadline) {
			throw new Error(`Timed out waiting for ${input.label}`);
		}

		await delay(POLL_INTERVAL_MS);
		return poll();
	};

	const result = await poll();
	return result;
};

const sampleIdleTreeRss = async (durationMs = 750): Promise<number> => {
	const deadline = performance.now() + durationMs;
	const sample = async (peak: number): Promise<number> => {
		if (performance.now() >= deadline) {
			return Math.max(peak, processTreeRssBytes());
		}

		await delay(TREE_SAMPLE_INTERVAL_MS);
		return sample(Math.max(peak, processTreeRssBytes()));
	};

	const peak = await sample(processTreeRssBytes());
	return peak;
};

const absolutePathOf = (rootDir: string, targetPath: string): string => {
	const absolutePath = path.resolve(rootDir, targetPath);
	const relativePath = path.relative(rootDir, absolutePath);

	if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		throw new Error(`Edit target escapes the benchmark workspace: ${targetPath}`);
	}

	return absolutePath;
};

const appendEdit = (absolutePath: string, iteration: number): void => {
	appendFileSync(absolutePath, `\n-- codeindex multi-adapter edit ${String(iteration)}\n`, {encoding: 'utf8'});
};

const machineOf = (): MultiAdapterReportType['machine'] => ({
	nodeVersion: process.version,
	platform: process.platform,
	arch: process.arch,
	cpuModel: os.cpus().at(0)?.model ?? 'unknown',
	totalMemoryBytes: os.totalmem(),
});

const freshStatus = (index: ReturnType<typeof createCodeIndex>): IndexStatusType => index.getStatus();

const publishAfter = async (
	input: Readonly<{
		index: ReturnType<typeof createCodeIndex>;
		previousRevision: number;
		timeoutMs: number;
		label: string;
	}>,
): Promise<Readonly<{revision: number; generationId: string | null}>> => {
	const published = await waitFor({
		attempt: () => {
			const status = freshStatus(input.index);
			return status.refresh === 'current' && typeof status.revision === 'number' && status.revision !== input.previousRevision
				? {revision: status.revision, generationId: status.generationId}
				: null;
		},
		timeoutMs: input.timeoutMs,
		label: input.label,
	});

	return published;
};

const churnOnce = async (
	input: Readonly<{
		index: ReturnType<typeof createCodeIndex>;
		absolutePath: string;
		timeoutMs: number;
	}>,
): Promise<void> => {
	const before = freshStatus(input.index).revision ?? 0;
	appendEdit(input.absolutePath, 0);

	const building = await waitFor({
		attempt: () => (freshStatus(input.index).refresh === 'building' ? true : null),
		timeoutMs: CHURN_BUILD_TIMEOUT_MS,
		label: 'churn build start',
	}).catch(() => null);

	if (building !== null) {
		appendEdit(input.absolutePath, 1);
	}

	await publishAfter({index: input.index, previousRevision: before, timeoutMs: input.timeoutMs, label: 'churn publication'});
};

const wrappedAdapters = (adapters: readonly AdapterType[], recorder: MultiAdapterRecorder, counterState: CounterStateType): readonly AdapterType[] =>
	adapters.map((adapter) => {
		const key = adapterIdOf(adapter.id);

		return {
			...adapter,
			probe: async (config): Promise<AdapterProbeResultType> => {
				counterState[key].probes += 1;
				recorder.markOperation(adapter.id, 'probe');
				const result: AdapterProbeResultType = adapter.probe === undefined ? {available: true} : await adapter.probe(config);
				return result;
			},
			scan: async (config, knownPaths) => {
				counterState[key].scans += 1;
				recorder.markOperation(adapter.id, 'scan');
				const result = await adapter.scan(config, knownPaths);
				return result;
			},
		};
	});

const configFor = (workspace: PreparedMultiAdapterWorkspaceType): ConfigType =>
	benchmarkConfigOf({
		configPath: workspace.corpus.configPath,
		rootDir: workspace.rootDir,
		databasePath: workspace.databasePath,
	});

const contextCountsOf = (config: ConfigType): Readonly<{typescript: number; oracle: number}> => {
	const adapters = config.adapters ?? [];
	const typescript = adapters.find((adapter) => adapter.id === 'typescript')?.projects.length ?? 0;
	const oracle = adapters.find((adapter) => adapter.id === 'oracle')?.projects.length ?? 0;

	return {typescript, oracle};
};

const openDatabase = (config: ConfigType): IndexDatabase =>
	IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectId: config.projectId,
		projects: (config.adapters ?? []).map((adapter) => ({
			adapterId: adapter.id,
			projectId: config.projectId,
			projectFilePath: adapter.projectFilePath,
		})),
	});

const absoluteTargetsOf = (workspace: PreparedMultiAdapterWorkspaceType): Record<AdapterIdType, string> => {
	const targets = workspace.corpus.metadata.editTargets;
	const typescript = targets.find((target) => target.adapterId === 'typescript');
	const oracle = targets.find((target) => target.adapterId === 'oracle');

	if (typescript === undefined || oracle === undefined) {
		throw new Error('Multi-adapter corpus must declare one TypeScript and one Oracle edit target');
	}

	return {
		typescript: absolutePathOf(workspace.rootDir, typescript.path),
		oracle: absolutePathOf(workspace.rootDir, oracle.path),
	};
};

const createBenchmarkIndex = async (
	input: Readonly<{
		config: ConfigType;
		recorder: MultiAdapterRecorder;
		counterState: CounterStateType;
		workerEntry?: string | undefined;
	}>,
): Promise<BenchmarkIndexType> => {
	const adapterSet = await loadConfiguredAdapters(input.config);
	const database = openDatabase(input.config);
	const index = createCodeIndex(input.config, database, LOGGER, {
		watch: true,
		analytics: input.recorder,
		adapters: wrappedAdapters(adapterSet.adapters, input.recorder, input.counterState),
		adapterDescriptors: adapterSet.descriptors,
		...(input.workerEntry === undefined ? {} : {workerEntry: input.workerEntry}),
	});

	return {index};
};

const roundCountersOf = (
	input: Readonly<{
		events: readonly RecordedEventType[];
		before: CounterStateType;
		after: CounterStateType;
	}>,
): Readonly<Record<AdapterIdType, AdapterCountersType>> => {
	const activity = input.events.reduce<Readonly<Record<AdapterIdType, AdapterCountersType>>>(
		(total, entry) => {
			if (entry.event !== 'build_complete') {
				return total;
			}

			const measured = activityCountersOf(entry.fields);
			return {
				typescript: addCounters(total.typescript, measured.typescript),
				oracle: addCounters(total.oracle, measured.oracle),
			};
		},
		{typescript: zeroCounters(), oracle: zeroCounters()},
	);

	return {
		typescript: addCounters(activity.typescript, {
			probes: input.after.typescript.probes - input.before.typescript.probes,
			scans: input.after.typescript.scans - input.before.typescript.scans,
			extractions: 0,
			factWrites: 0,
		}),
		oracle: addCounters(activity.oracle, {
			probes: input.after.oracle.probes - input.before.oracle.probes,
			scans: input.after.oracle.scans - input.before.oracle.scans,
			extractions: 0,
			factWrites: 0,
		}),
	};
};

const measureRound = async (
	input: Readonly<{
		index: ReturnType<typeof createCodeIndex>;
		recorder: MultiAdapterRecorder;
		counterState: CounterStateType;
		targets: Record<AdapterIdType, string>;
		targetPaths: Record<AdapterIdType, string>;
		iteration: number;
		timeoutMs: number;
	}>,
): Promise<Readonly<{sample: MultiAdapterEditSampleType; isolation: MultiAdapterIsolationRoundType}>> => {
	const adapterId = input.iteration % 2 === 1 ? 'typescript' : 'oracle';
	const previousRevision = freshStatus(input.index).revision ?? 0;
	const eventStart = input.recorder.length;
	const before = {typescript: {...input.counterState.typescript}, oracle: {...input.counterState.oracle}};
	const startedAt = performance.now();
	appendEdit(input.targets[adapterId], input.iteration);
	const published = await publishAfter({
		index: input.index,
		previousRevision,
		timeoutMs: input.timeoutMs,
		label: `edit ${String(input.iteration)} publication`,
	});
	const latencyMs = Math.round(performance.now() - startedAt);
	const events = input.recorder.eventsSince(eventStart);
	const publication = events.toReversed().find((entry) => entry.event === 'refresh_published');
	const eventToPublicationMs = publication === undefined ? null : numberField(publication.fields, 'eventToPublicationMs');

	if (eventToPublicationMs === null) {
		throw new Error(`Edit ${String(input.iteration)} published without an event-to-publication measurement`);
	}

	const counters = roundCountersOf({
		events,
		before,
		after: {typescript: {...input.counterState.typescript}, oracle: {...input.counterState.oracle}},
	});

	return {
		sample: {
			iteration: input.iteration,
			adapterId,
			path: input.targetPaths[adapterId],
			latencyMs,
			eventToPublicationMs,
			revision: published.revision,
		},
		isolation: {iteration: input.iteration, sourceAdapterId: adapterId, typescript: counters.typescript, oracle: counters.oracle},
	};
};

const runRounds = async (
	input: Readonly<{
		index: ReturnType<typeof createCodeIndex>;
		recorder: MultiAdapterRecorder;
		counterState: CounterStateType;
		targets: Record<AdapterIdType, string>;
		targetPaths: Record<AdapterIdType, string>;
		rounds: number;
		timeoutMs: number;
	}>,
	iteration: number,
	accumulator: RoundAccumulatorType,
): Promise<RoundAccumulatorType> => {
	if (iteration > input.rounds) {
		return accumulator;
	}

	const measured = await measureRound({
		index: input.index,
		recorder: input.recorder,
		counterState: input.counterState,
		targets: input.targets,
		targetPaths: input.targetPaths,
		iteration,
		timeoutMs: input.timeoutMs,
	});
	const source = measured.isolation.sourceAdapterId;
	accumulator.samples.push({...measured.sample, path: input.targetPaths[source]});
	accumulator.isolationRounds.push(measured.isolation);
	accumulator.totals[source].typescript = addCounters(accumulator.totals[source].typescript, measured.isolation.typescript);
	accumulator.totals[source].oracle = addCounters(accumulator.totals[source].oracle, measured.isolation.oracle);

	return runRounds(input, iteration + 1, accumulator);
};

const finalReport = (
	input: Readonly<{
		workspace: PreparedMultiAdapterWorkspaceType;
		config: ConfigType;
		edit: MultiAdapterReportType['edit'];
		isolation: MultiAdapterReportType['isolation'];
		supersession: MultiAdapterSupersessionType;
		resources: MultiAdapterReportType['resources'];
		freshness: QueryFreshnessType;
		counts: Readonly<{files: number; symbols: number}>;
		databasePath: string;
	}>,
): MultiAdapterReportType => {
	const contexts = contextCountsOf(input.config);
	const storage = databaseBytesOf(input.databasePath);

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		machine: machineOf(),
		corpus: {
			id: input.workspace.corpus.metadata.id,
			sha256: input.workspace.corpus.sha256,
			typescriptProjectContexts: contexts.typescript,
			oracleProjectContexts: contexts.oracle,
			fileCount: input.counts.files,
			symbolCount: input.counts.symbols,
			editTargets: input.workspace.corpus.metadata.editTargets,
		},
		edit: input.edit,
		isolation: input.isolation,
		supersession: input.supersession,
		resources: input.resources,
		storage: {databaseBytes: storage.main, walBytes: storage.wal, shmBytes: storage.shm},
		freshness: {state: input.freshness.state, dirtyFileCount: input.freshness.dirtyFileCount},
	};
};

/**
 * Runs the multi-adapter edit-to-fresh benchmark.
 *
 * The corpus is copied before measurement. A real watcher, debounce, targeted
 * refresh, build worker, and publication path are exercised per sample.
 * @param input - Prepared workspace, rounds, and timing controls.
 * @returns Complete report consumed by the absolute gates.
 */
export const runMultiAdapterScenario = async (
	input: Readonly<{
		workspace: PreparedMultiAdapterWorkspaceType;
		rounds: number;
		timeoutMs?: number;
		workerEntry?: string | undefined;
		churn?: boolean;
	}>,
): Promise<MultiAdapterReportType> => {
	const timeoutMs = input.timeoutMs ?? 60_000;
	const config = configFor(input.workspace);
	const recorder = new MultiAdapterRecorder();
	const counterState: CounterStateType = {typescript: zeroCounters(), oracle: zeroCounters()};
	const {index} = await createBenchmarkIndex({
		config,
		recorder,
		counterState,
		...(input.workerEntry === undefined ? {} : {workerEntry: input.workerEntry}),
	});
	const targets = absoluteTargetsOf(input.workspace);
	const targetPaths = {
		typescript: input.workspace.corpus.metadata.editTargets.find((target) => target.adapterId === 'typescript')?.path ?? '',
		oracle: input.workspace.corpus.metadata.editTargets.find((target) => target.adapterId === 'oracle')?.path ?? '',
	};
	const resources = startResourceSampler();

	try {
		await index.ensureReady();
		index.start();
		await waitFor({
			attempt: () => (freshStatus(index).refresh === 'current' ? true : null),
			timeoutMs,
			label: 'initial watcher publication',
		});
		await delay(200);

		if (input.churn !== false) {
			await churnOnce({index, absolutePath: targets.typescript, timeoutMs});
			await churnOnce({index, absolutePath: targets.oracle, timeoutMs});
		}

		const idleProcessTreeRssBytes = await sampleIdleTreeRss();
		const measured = await runRounds({index, recorder, counterState, targets, targetPaths, rounds: input.rounds, timeoutMs}, 1, {
			samples: [],
			isolationRounds: [],
			totals: {
				typescript: {typescript: zeroCounters(), oracle: zeroCounters()},
				oracle: {typescript: zeroCounters(), oracle: zeroCounters()},
			},
		});
		const status = freshStatus(index);
		const sample = resources.stop();

		return finalReport({
			workspace: input.workspace,
			config,
			edit: {
				rounds: input.rounds,
				debounceMs: config.freshnessDebounceMs,
				samples: measured.samples,
				percentiles: summarize(measured.samples.map((entry) => entry.eventToPublicationMs)),
			},
			isolation: {
				typescriptEdits: measured.totals.typescript,
				oracleEdits: measured.totals.oracle,
				rounds: measured.isolationRounds,
			},
			supersession: recorder.supersession(),
			resources: {
				processTreeRssPeakBytes: sample.processTreeRssPeakBytes ?? sample.rssPeakBytes,
				processTreeRssIdleBytes: idleProcessTreeRssBytes,
				rssPeakBytes: sample.rssPeakBytes,
			},
			freshness: index.getFreshness(),
			counts: status.counts,
			databasePath: config.databasePath,
		});
	} finally {
		await index.close();
	}
};
