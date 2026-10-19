import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {type ConfigType} from '../config/config.ts';
import {createCodeIndex} from '../generation/codeIndex.ts';
import {createLogger} from '../logging/logger.ts';
import {type IndexStatusType} from '../model.ts';
import {IndexDatabase} from '../storage/database.ts';
import {type BenchmarkBuildType, type BenchmarkEditSampleType, type BenchmarkEditScenarioType} from './benchTypes.ts';
import {reuseOf} from './buildScenarios.ts';
import {summarize} from './percentiles.ts';
import {readStorage, startResourceSampler} from './resources.ts';

const LOGGER = createLogger({minimumLevel: 'error'});
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 10;

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

const buildOf = (build: IndexStatusType['build']): BenchmarkBuildType | null =>
	build.durationMs === null ? null : {reused: false, durationMs: build.durationMs, stages: build.stages};

const targetPathOf = (input: Readonly<{index: ReturnType<typeof createCodeIndex>; explicit: string | undefined}>): string => {
	if (input.explicit !== undefined) {
		return input.explicit;
	}

	const symbol = input.index.findSymbols({query: 'feature', limit: 100}).items.find((item) => item.path.endsWith('.ts'));

	if (symbol === undefined) {
		throw new Error('Edit-to-fresh benchmark requires at least one indexed TypeScript symbol');
	}

	return symbol.path;
};

/**
 * Measures wall time from one source write until a fresh generation is current.
 *
 * The real watcher, debounce, scan, and worker build are part of the path.
 *
 * @param input - Configuration, rounds, timeout, and optional target path.
 * @returns Edit latency samples and final generation metrics.
 */
export const runEditScenario = async (
	input: Readonly<{
		config: ConfigType;
		rounds: number;
		timeoutMs?: number;
		targetPath?: string;
		debounceMs?: number;
		workerEntry?: string | undefined;
	}>,
): Promise<BenchmarkEditScenarioType> => {
	const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const scenarioStartedAt = performance.now();
	const resources = startResourceSampler();
	const database = IndexDatabase.open(input.config.databasePath, {
		rootDir: input.config.rootDir,
		projectFilePath: input.config.projectFilePath,
		extractorId: input.config.extractorId,
		projectId: input.config.projectId,
	});
	const beforeContent = new Set(database.contentHashes());
	const artifactRowsBefore = database.extractionArtifactCount();
	const index = createCodeIndex(input.config, database, LOGGER, {
		watch: true,
		debounceMs,
		...(input.workerEntry === undefined ? {} : {workerEntry: input.workerEntry}),
	});

	try {
		await index.ensureReady();
		index.start();
		await delay(debounceMs + 200);
		await waitFor({attempt: () => (index.getStatus().refresh === 'current' ? true : null), timeoutMs, label: 'initial watcher refresh'});
		const targetPath = targetPathOf({index, explicit: input.targetPath});
		const absolutePath = path.resolve(input.config.rootDir, targetPath);
		const samples: BenchmarkEditSampleType[] = [];
		const runRound = async (iteration: number): Promise<void> => {
			if (iteration > input.rounds) {
				return;
			}

			const previous = index.getStatus().generationId;
			appendFileSync(absolutePath, `\nexport const benchmarkEdit${String(process.pid)}_${String(iteration)} = ${String(iteration)};\n`, {encoding: 'utf8'});
			const startedAt = performance.now();
			const status = await waitFor({
				attempt: () => {
					const current = index.getStatus();
					return current.generationId !== previous && current.refresh === 'current' ? current : null;
				},
				timeoutMs,
				label: `edit ${String(iteration)} publication`,
			});

			samples.push({
				iteration,
				latencyMs: Math.round(performance.now() - startedAt),
				generationId: status.generationId ?? '',
			});
			return runRound(iteration + 1);
		};

		await runRound(1);

		const status = index.getStatus();
		const files = status.generationId === null ? [] : database.listFiles(status.generationId);
		const storage = readStorage(database, input.config.databasePath);
		const generation = status.generationId === null ? null : database.getGeneration(status.generationId);

		return {
			kind: 'edit',
			name: 'edit_to_fresh',
			wallMs: Math.round(performance.now() - scenarioStartedAt),
			rounds: input.rounds,
			debounceMs,
			samples,
			percentiles: summarize(samples.map((sample) => sample.latencyMs)),
			build: buildOf(status.build),
			resources: resources.stop(),
			storage,
			reuse: reuseOf({
				report: {reused: false, fileCount: generation?.fileCount ?? 0, generationId: generation?.id ?? ''},
				beforeContent,
				artifactRowsBefore,
				artifactRowsAfter: storage.extractionArtifacts,
				files,
			}),
		};
	} finally {
		await index.close();
	}
};
